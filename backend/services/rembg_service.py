"""
Background Removal Service
==========================
Profile-based background removal with per-step timing for A/B comparison.

Profiles ship out of the box, switchable live from the admin Feature Flags panel:

Local (CPU, ~0.5-1.5 s, always available):
  - "human_hi"     : model=u2net_human_seg,    max_input=1200 px, alpha-feather on
                     Human-specialized; best local default for a people booth.
  - "isnet_hi"     : model=isnet-general-use,  max_input=1200 px, alpha-feather on
                     Cleaner edges (hair, turban, collar). ~+0.7-1.0 s vs silueta.
  - "silueta_hi"   : model=silueta,            max_input=1600 px, alpha-feather on
                     Faster. Coarser edges but more pixels — good for full-body
                     compositions where edges are less prominent.

Cloud (fal.ai BiRefNet v2 on GPU, ~2-4 s, needs FAL_KEY — see cloud_rembg.py):
  - "cloud_birefnet_portrait" / "_matting" / "_general"
                     Three BiRefNet variants, so the winner can be chosen by A/B
                     from the admin panel rather than a code change. Each falls
                     back to the local pipeline automatically if fal is unusable.

Local profiles run a small Gaussian alpha-feather pass to smooth stair-step edges
from the segmentation network. Cloud results skip it — BiRefNet's refine_foreground
already returns matted, decontaminated edges.

Sessions are cached per model. Switching profiles at runtime lazily loads the
new model on its first use (one-time cost).

Per-step timings are printed in a compact one-line summary so you can grep
PERF [rembg] across two runs and diff them.
"""

import asyncio
import time
from io import BytesIO

from PIL import Image, ImageFilter
from rembg import new_session, remove

from services.cloud_rembg import CloudRembgError, remove_background_cloud
from services.feature_flags_service import get_rembg_profile, get_sticker_effect, get_sticker_stroke_color, get_sticker_stroke_width, get_edge_cleanup
from services.sticker_effects import (
    apply_drop_shadow,
    apply_stroke,
    apply_unsharp,
    clean_alpha_islands,
    decontaminate_edges,
)

# --- Profile definitions ------------------------------------------------------

PROFILES: dict[str, dict] = {
    "human_hi": {
        # Human-specialized model: understands the body silhouette, so it doesn't
        # bleed the foreground into busy backgrounds (office clutter, similar-colored
        # walls) the way the general models do. Cleaner edges AND faster (~0.5s).
        "model": "u2net_human_seg",
        "max_input": 1200,
        "alpha_feather": 0.8,
    },
    "isnet_hi": {
        "model": "isnet-general-use",
        "max_input": 1200,
        "alpha_feather": 0.8,   # GaussianBlur radius in px on the alpha channel
    },
    "silueta_hi": {
        "model": "silueta",
        "max_input": 1600,
        "alpha_feather": 0.8,
    },
}

# --- Cloud profiles (fal.ai BiRefNet v2, GPU) ---------------------------------
# Three variants so the winner can be picked by A/B from the admin panel instead
# of a code change. Each inherits human_hi's local settings: that is what the
# automatic fallback runs when fal is unconfigured / unreachable / circuit-broken,
# and what warm_up() pre-loads, so selecting a cloud profile still boots a usable
# local model.
_CLOUD_VARIANTS = {
    "cloud_birefnet_portrait": "Portrait",
    "cloud_birefnet_matting": "Matting",
    "cloud_birefnet_general": "General Use (Heavy)",
}

PROFILES.update(
    {
        name: {
            **PROFILES["human_hi"],
            "cloud": True,
            "fal_model": fal_model,
            "operating_resolution": "1024x1024",
        }
        for name, fal_model in _CLOUD_VARIANTS.items()
    }
)

DEFAULT_PROFILE = "human_hi"


def _resolve_profile(name: str | None) -> tuple[str, dict]:
    """Return (profile_name, profile_dict). Falls back to DEFAULT_PROFILE."""
    if name and name in PROFILES:
        return name, PROFILES[name]
    return DEFAULT_PROFILE, PROFILES[DEFAULT_PROFILE]


class BackgroundRemovalService:
    """
    Background removal with profile-based model + per-step timing.

    Sessions are cached per model name and reused across calls. When the admin
    flips the profile, the next request lazily creates a session for the new
    model — a one-time cost.
    """

    def __init__(self):
        self._sessions: dict[str, object] = {}
        self._warmed_up = False

    def warm_up(self):
        """Pre-load the model for the currently configured profile."""
        if self._warmed_up:
            return
        name, profile = _resolve_profile(get_rembg_profile())
        print(f"INFO: Pre-warming rembg profile='{name}' model={profile['model']}...", flush=True)
        sess = self._get_session(profile["model"])
        dummy = Image.new("RGB", (64, 64), (128, 128, 128))
        remove(dummy, session=sess)
        self._warmed_up = True
        print(f"INFO: rembg warm-up complete profile='{name}'", flush=True)

    def _get_session(self, model_name: str):
        sess = self._sessions.get(model_name)
        if sess is None:
            t0 = time.perf_counter()
            print(f"INFO: rembg loading model='{model_name}'...", flush=True)
            sess = new_session(model_name)
            self._sessions[model_name] = sess
            print(f"INFO: rembg model='{model_name}' loaded in {time.perf_counter() - t0:.2f}s", flush=True)
        return sess

    @staticmethod
    def _downsize_image(image: Image.Image, max_dim: int) -> tuple[Image.Image, bool]:
        """Return (image, did_downsize)."""
        w, h = image.size
        if w <= max_dim and h <= max_dim:
            return image, False
        scale = max_dim / max(w, h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        return image.resize((new_w, new_h), Image.Resampling.BILINEAR), True

    @staticmethod
    def _feather_alpha(img: Image.Image, radius: float) -> Image.Image:
        """Soften the alpha channel with a tiny Gaussian blur to kill stair-step edges."""
        if radius <= 0 or img.mode != "RGBA":
            return img
        r, g, b, a = img.split()
        a_soft = a.filter(ImageFilter.GaussianBlur(radius=radius))
        return Image.merge("RGBA", (r, g, b, a_soft))

    @staticmethod
    def _alpha_metrics(img: Image.Image) -> dict:
        """
        Compute quality metrics from the alpha channel.

        Returns:
          coverage_pct       — % of pixels that are fully or partially foreground (alpha > 0)
          opaque_pct         — % fully opaque (alpha == 255). Higher = smaller anti-aliased boundary.
          edge_pct           — % in the partially-transparent zone (1..254). The "soft edge" band.
                               A binary mask has edge_pct ~ 0; a feathered/matted mask is higher.
          bbox               — tight bbox of any non-zero alpha (subject extent)
          mean_alpha         — average alpha 0..255 (sanity check)
        """
        if img.mode != "RGBA":
            return {}
        a = img.getchannel("A")
        hist = a.histogram()  # 256 bins
        total = sum(hist) or 1
        opaque = hist[255]
        transparent = hist[0]
        edge = total - opaque - transparent
        bbox = a.getbbox()
        bbox_str = f"{bbox[2]-bbox[0]}x{bbox[3]-bbox[1]}" if bbox else "0x0"
        mean_alpha = sum(i * c for i, c in enumerate(hist)) / total
        return {
            "coverage_pct": 100.0 * (total - transparent) / total,
            "opaque_pct": 100.0 * opaque / total,
            "edge_pct": 100.0 * edge / total,
            "bbox": bbox_str,
            "mean_alpha": mean_alpha,
        }

    def _infer_local(
        self, input_image: Image.Image, profile: dict, use_alpha_matting: bool
    ) -> tuple[Image.Image, dict]:
        """CPU inference via rembg. Also the fallback path for cloud profiles."""
        m: dict = {"source": "local"}

        # 1) downsize
        t0 = time.perf_counter()
        resized, did_downsize = self._downsize_image(input_image, profile["max_input"])
        m["downsize_ms"] = (time.perf_counter() - t0) * 1000
        m["did_downsize"] = did_downsize
        m["input_size"] = f"{resized.width}x{resized.height}"
        m["input_megapixels"] = (resized.width * resized.height) / 1_000_000

        # 2) inference — alpha_matting is rembg's built-in edge refinement and
        # has to be a kwarg on remove(); the other three effects are post-process.
        sess = self._get_session(profile["model"])
        t0 = time.perf_counter()
        if use_alpha_matting:
            matting_kwargs = dict(
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=10,
                alpha_matting_erode_size=4,
            )
            print(
                f"EFFECT [alpha_matting] fg_threshold=240 bg_threshold=10 erode_size=4 "
                f"(runs inside rembg.remove(); cost is folded into inference_ms)",
                flush=True,
            )
            raw_out = remove(resized, session=sess, **matting_kwargs)
        else:
            raw_out = remove(resized, session=sess)
        m["inference_ms"] = (time.perf_counter() - t0) * 1000
        return raw_out, m

    @staticmethod
    def _infer_cloud(input_image: Image.Image, profile: dict) -> tuple[Image.Image, dict]:
        """BiRefNet on fal.ai. Raises CloudRembgError — caller falls back to local."""
        raw_out, cm = remove_background_cloud(
            input_image,
            fal_model=profile["fal_model"],
            operating_resolution=profile.get("operating_resolution", "1024x1024"),
        )
        return raw_out, {
            "source": "cloud",
            # Mapped onto the same metric names the local path uses so the PERF
            # line stays one greppable format across both.
            "downsize_ms": cm["encode_ms"],
            "did_downsize": cm["did_downsize"],
            "input_size": cm["input_size"],
            "input_megapixels": cm["input_megapixels"],
            "inference_ms": cm["request_ms"],
            "upload_kb": cm["upload_kb"],
            "ttfb_ms": cm["ttfb_ms"],
            "download_ms": cm["download_ms"],
            "decode_ms": cm["decode_ms"],
            "fal_model": cm["fal_model"],
        }

    def _remove_sync(self, input_image: Image.Image, profile: dict) -> tuple[Image.Image, dict]:
        """
        Synchronous removal. Returns (output_image, metrics_dict).
        """
        metrics: dict = {}
        t_start = time.perf_counter()

        # Resolve sticker effect for this call so admin can hot-swap
        effect = get_sticker_effect()
        use_alpha_matting = (effect == "alpha_matting")
        metrics["effect"] = effect

        # 1+2) downsize + inference. Cloud profiles try fal first; *any* failure
        # (no key, open breaker, timeout, bad response) drops through to the local
        # pipeline, so a bad venue uplink costs quality but never stalls the booth.
        raw_out = None
        if profile.get("cloud"):
            try:
                raw_out, cloud_metrics = self._infer_cloud(input_image, profile)
                metrics.update(cloud_metrics)
            except CloudRembgError as exc:
                print(f"CLOUD-FALLBACK reason={exc}", flush=True)
                metrics["cloud_fallback_reason"] = str(exc)

        if raw_out is None:
            raw_out, local_metrics = self._infer_local(input_image, profile, use_alpha_matting)
            metrics.update(local_metrics)

        from_cloud = metrics["source"] == "cloud"
        # alpha_matting exists only on the rembg path; on a cloud result the
        # equivalent (refine_foreground) already ran server-side.
        matting_applied = use_alpha_matting and not from_cloud

        # 2b) pre-feather alpha metrics (what the model itself produced)
        pre = self._alpha_metrics(raw_out)
        metrics["pre_feather_opaque_pct"] = pre.get("opaque_pct", 0.0)
        metrics["pre_feather_edge_pct"] = pre.get("edge_pct", 0.0)

        # 3) feather — skipped whenever the edges are already properly matted:
        # alpha_matting output, or a cloud result (refine_foreground). Blurring
        # those would only wash out what we paid for.
        t0 = time.perf_counter()
        if matting_applied or from_cloud:
            out = raw_out
        else:
            out = self._feather_alpha(raw_out, profile.get("alpha_feather", 0.0))
        metrics["feather_ms"] = (time.perf_counter() - t0) * 1000

        # 3b) edge cleanup (background-independent): drop segmentation ghosts and
        # recolor the soft edge ring with the subject's own colour so no old-background
        # halo survives onto the new template. Cheap (~tens of ms). Default ON.
        # On cloud results only the island sweep runs — cheap insurance against stray
        # blobs — since refine_foreground already decontaminated the edge ring.
        t0 = time.perf_counter()
        if get_edge_cleanup() and not matting_applied:
            out = clean_alpha_islands(out, low_alpha_cut=12, min_area_frac=0.02)
            if not from_cloud:
                out = decontaminate_edges(out, grow=4, shrink=1)
        metrics["cleanup_ms"] = (time.perf_counter() - t0) * 1000

        # 4) post-process effect (stroke / shadow / unsharp).
        # alpha_matting is handled above; "none" is a no-op.
        t0 = time.perf_counter()
        if effect == "stroke":
            out = apply_stroke(out, width=get_sticker_stroke_width(), color=get_sticker_stroke_color())
        elif effect == "shadow":
            out = apply_drop_shadow(out)
        elif effect == "unsharp":
            out = apply_unsharp(out)
        metrics["effect_ms"] = (time.perf_counter() - t0) * 1000

        # 4b) post-effect metrics
        post = self._alpha_metrics(out)
        metrics.update({
            "coverage_pct": post.get("coverage_pct", 0.0),
            "opaque_pct": post.get("opaque_pct", 0.0),
            "edge_pct": post.get("edge_pct", 0.0),
            "subject_bbox": post.get("bbox", "0x0"),
            "mean_alpha": post.get("mean_alpha", 0.0),
        })

        metrics["total_ms"] = (time.perf_counter() - t_start) * 1000
        metrics["output_size"] = f"{out.width}x{out.height}"
        return out, metrics

    async def remove_background(
        self,
        image_bytes: bytes,
    ) -> Image.Image:
        """
        Remove background asynchronously. Logs a structured PERF summary
        suitable for diffing across two model profiles.
        """
        # Decode
        t_decode = time.perf_counter()
        input_image = Image.open(BytesIO(image_bytes))
        original_size = f"{input_image.width}x{input_image.height}"
        decode_ms = (time.perf_counter() - t_decode) * 1000

        # Resolve profile per call so admin can hot-swap
        profile_name, profile = _resolve_profile(get_rembg_profile())

        # Run CPU work in a thread
        out, m = await asyncio.to_thread(self._remove_sync, input_image, profile)

        # A cloud run reports upload size + result-decode time; a cloud profile that
        # fell back to local reports why, so `grep CLOUD-FALLBACK` and the PERF line
        # tell the same story.
        if m["source"] == "cloud":
            cloud_bits = (
                f"upload={m['upload_kb']:.0f}KB ttfb={m['ttfb_ms']:.0f}ms "
                f"download={m['download_ms']:.0f}ms result_decode={m['decode_ms']:.0f}ms "
            )
        elif m.get("cloud_fallback_reason"):
            cloud_bits = f"cloud_fallback='{m['cloud_fallback_reason']}' "
        else:
            cloud_bits = ""

        # Two-line log: timing first (easy to grep), then quality metrics.
        print(
            f"PERF [rembg] profile={profile_name} source={m['source']} "
            f"model={m.get('fal_model') or profile['model']} feather={profile['alpha_feather']} "
            f"effect={m['effect']} "
            f"orig={original_size} -> input={m['input_size']} ({m['input_megapixels']:.2f}MP) "
            f"| decode={decode_ms:.0f}ms downsize={m['downsize_ms']:.0f}ms "
            f"inference={m['inference_ms']:.0f}ms feather={m['feather_ms']:.0f}ms "
            f"cleanup={m.get('cleanup_ms', 0):.0f}ms effect={m['effect_ms']:.0f}ms "
            f"{cloud_bits}"
            f"TOTAL={m['total_ms']:.0f}ms",
            flush=True,
        )
        print(
            f"QUAL [rembg] profile={profile_name} source={m['source']} effect={m['effect']} out={m['output_size']} "
            f"subject_bbox={m['subject_bbox']} "
            f"coverage={m['coverage_pct']:.1f}% opaque={m['opaque_pct']:.1f}% edge_band={m['edge_pct']:.2f}% "
            f"mean_alpha={m['mean_alpha']:.1f} "
            f"(pre-feather opaque={m['pre_feather_opaque_pct']:.1f}% edge={m['pre_feather_edge_pct']:.2f}%)",
            flush=True,
        )
        return out


rembg_service = BackgroundRemovalService()
