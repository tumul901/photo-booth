"""
Background Removal Service
==========================
Profile-based background removal with per-step timing for A/B comparison.

Two profiles ship out of the box (configurable from admin UI via feature flags):

  - "isnet_hi"     : model=isnet-general-use, max_input=1200 px, alpha-feather on
                     Cleaner edges (hair, turban, collar). ~+0.7-1.0 s vs silueta.
  - "silueta_hi"   : model=silueta,            max_input=1600 px, alpha-feather on
                     Faster. Coarser edges but more pixels — good for full-body
                     compositions where edges are less prominent.

Both profiles run a small Gaussian alpha-feather pass to smooth stair-step
edges from the segmentation network.

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

from services.feature_flags_service import get_rembg_profile, get_sticker_effect, get_sticker_stroke_color, get_sticker_stroke_width
from services.sticker_effects import (
    apply_drop_shadow,
    apply_stroke,
    apply_unsharp,
)

# --- Profile definitions ------------------------------------------------------

PROFILES: dict[str, dict] = {
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

DEFAULT_PROFILE = "isnet_hi"


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

    def _remove_sync(self, input_image: Image.Image, profile: dict) -> tuple[Image.Image, dict]:
        """
        Synchronous removal. Returns (output_image, metrics_dict).
        """
        metrics: dict = {}
        t_start = time.perf_counter()

        # 1) downsize
        t0 = time.perf_counter()
        resized, did_downsize = self._downsize_image(input_image, profile["max_input"])
        metrics["downsize_ms"] = (time.perf_counter() - t0) * 1000
        metrics["did_downsize"] = did_downsize
        metrics["input_size"] = f"{resized.width}x{resized.height}"
        metrics["input_megapixels"] = (resized.width * resized.height) / 1_000_000

        # Resolve sticker effect for this call so admin can hot-swap
        effect = get_sticker_effect()
        use_alpha_matting = (effect == "alpha_matting")
        metrics["effect"] = effect

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
        metrics["inference_ms"] = (time.perf_counter() - t0) * 1000

        # 2b) pre-feather alpha metrics (what the model itself produced)
        pre = self._alpha_metrics(raw_out)
        metrics["pre_feather_opaque_pct"] = pre.get("opaque_pct", 0.0)
        metrics["pre_feather_edge_pct"] = pre.get("edge_pct", 0.0)

        # 3) feather (skip when alpha_matting is on — its output already has
        # carefully-computed soft edges and we don't want to wash them out).
        t0 = time.perf_counter()
        if use_alpha_matting:
            out = raw_out
        else:
            out = self._feather_alpha(raw_out, profile.get("alpha_feather", 0.0))
        metrics["feather_ms"] = (time.perf_counter() - t0) * 1000

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

        # Two-line log: timing first (easy to grep), then quality metrics.
        print(
            f"PERF [rembg] profile={profile_name} model={profile['model']} feather={profile['alpha_feather']} "
            f"effect={m['effect']} "
            f"orig={original_size} -> input={m['input_size']} ({m['input_megapixels']:.2f}MP) "
            f"| decode={decode_ms:.0f}ms downsize={m['downsize_ms']:.0f}ms "
            f"inference={m['inference_ms']:.0f}ms feather={m['feather_ms']:.0f}ms "
            f"effect={m['effect_ms']:.0f}ms "
            f"TOTAL={m['total_ms']:.0f}ms",
            flush=True,
        )
        print(
            f"QUAL [rembg] profile={profile_name} effect={m['effect']} out={m['output_size']} "
            f"subject_bbox={m['subject_bbox']} "
            f"coverage={m['coverage_pct']:.1f}% opaque={m['opaque_pct']:.1f}% edge_band={m['edge_pct']:.2f}% "
            f"mean_alpha={m['mean_alpha']:.1f} "
            f"(pre-feather opaque={m['pre_feather_opaque_pct']:.1f}% edge={m['pre_feather_edge_pct']:.2f}%)",
            flush=True,
        )
        return out


rembg_service = BackgroundRemovalService()
