"""
Self-Hosted Background Removal — our own BiRefNet GPU box
=========================================================
Client for the ``bg-remover`` service (BiRefNet-matting on an EC2 GPU, fronted
by an NLB). Drives the ``selfhost_birefnet`` profile in ``rembg_service``.

Same model family as the ``cloud_birefnet_*`` fal.ai profiles and the same
quality, but on hardware we own: no per-photo cost, no third-party uplink, and
the box publishes its own load so a slow photo is attributable.

Contract with the caller, identical to ``cloud_rembg``: **never raise anything
but ``SelfhostRembgError``**, and raise it fast. ``rembg_service`` catches it and
runs the local pipeline instead, so a dead box costs quality but never stalls
the booth.

Request shape::

    POST {BG_SERVICE_URL}/remove-bg          (multipart)
      file            capture as JPEG
      refine_fg       true   — matted, decontaminated edges, server-side
      response_type   split  — see below
    -> binary body, plus X-Served-By / X-Inference-Time-Ms / X-Total-Time-Ms

── Point it at the NLB, not a box ──

``BG_SERVICE_URL`` should be the load balancer's name even while only one
instance is registered. With one target the NLB is a passthrough, and the day a
second box joins there is nothing to change here or redeploy. It also gives us
the TLS endpoint; the containers bind to loopback and are not reachable
directly.

One consequence worth knowing: the NLB health check goes green roughly 26
seconds before a freshly restarted box can actually serve, so a cold box can be
handed guest photos. That is survivable rather than fixed — ``BG_SERVICE_TIMEOUT_S``
is deliberately shorter than that cold window, so those photos fall back to the
local model quickly instead of making guests wait through CUDA autotuning.
"""

import struct
import time
from io import BytesIO

import requests
from PIL import Image

from config import settings
from services.cloud_rembg import (
    JPEG_QUALITY,
    MAX_UPLOAD_DIM,
    CircuitBreaker,
    CloudRembgError,
)

# ── The split wire format ────────────────────────────────────────────────────
#
# Mirrors the encoder in the service's main.py; keep the two in step.
#
# An RGBA cutout is two unrelated kinds of data in one file: a photograph, and a
# stencil that is mostly flat black and flat white. PNG is the only format that
# carries the stencil, and PNG is lossless-only, so bundling them forces the
# *photograph* to be stored losslessly too — the expensive half, which nothing
# needs. Measured on the box over 6 real cutouts: 1599 KB / 248 ms as one RGBA
# PNG against 284 KB / 29 ms split. Both axes at once.
#
# The shape stays bit-identical because the stencil is still lossless PNG; only
# colours *inside* an already-exact outline are approximated.
#
#     "BGRSPLT1"         8 bytes   magic
#     uint32 big-endian  4 bytes   length of the JPEG that follows
#     <jpeg>             N bytes   RGB, quality 92
#     <png>              rest      alpha as 8-bit greyscale
SPLIT_MAGIC = b"BGRSPLT1"
SPLIT_HEADER_LEN = len(SPLIT_MAGIC) + 4

_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 60.0


class SelfhostRembgError(CloudRembgError):
    """Any failure talking to our box. Subclasses CloudRembgError so
    rembg_service keeps a single fall-back-to-local catch for both remotes."""


# Its own breaker instance: a dead fal.ai must not switch off a healthy GPU box.
_breaker = CircuitBreaker(_BREAKER_THRESHOLD, _BREAKER_COOLDOWN_S)


def is_configured() -> bool:
    """True when a BG_SERVICE_URL is set. Surfaced to the admin panel so the
    profile can't be selected while silently running local."""
    return bool((settings.BG_SERVICE_URL or "").strip())


def breaker_open() -> bool:
    """Whether calls are currently being skipped (admin status display)."""
    return _breaker.is_open()


def _encode_upload(image: Image.Image) -> tuple[bytes, dict]:
    """Downscale + JPEG-encode for multipart. Returns (raw_bytes, metrics).

    Shares MAX_UPLOAD_DIM with the fal path on purpose. The box returns the
    cutout at the resolution we upload rather than the 1024 the model runs at,
    so this is what decides cutout size — and a cutout has to land the same size
    whether the self-hosted box, fal, or the local model produced it, or every
    downstream placement shifts when the profile changes.
    """
    t0 = time.perf_counter()
    img = image if image.mode == "RGB" else image.convert("RGB")
    w, h = img.size
    did_downsize = max(w, h) > MAX_UPLOAD_DIM
    if did_downsize:
        scale = MAX_UPLOAD_DIM / max(w, h)
        img = img.resize((int(w * scale), int(h * scale)), Image.Resampling.LANCZOS)

    buf = BytesIO()
    img.save(buf, format="JPEG", quality=JPEG_QUALITY)
    raw = buf.getvalue()
    return raw, {
        "encode_ms": (time.perf_counter() - t0) * 1000,
        "did_downsize": did_downsize,
        "input_size": f"{img.width}x{img.height}",
        "input_megapixels": (img.width * img.height) / 1_000_000,
        "upload_kb": len(raw) / 1024,
    }


def _decode_split(body: bytes) -> Image.Image:
    """Unpack JPEG(colour) + PNG(alpha) into one RGBA cutout."""
    jpeg_len = struct.unpack(">I", body[8:SPLIT_HEADER_LEN])[0]
    end = SPLIT_HEADER_LEN + jpeg_len
    if end > len(body):
        raise SelfhostRembgError(
            f"truncated split body: header claims {jpeg_len}B of JPEG, "
            f"only {len(body) - SPLIT_HEADER_LEN}B present"
        )

    rgb = Image.open(BytesIO(body[SPLIT_HEADER_LEN:end]))
    rgb.load()
    alpha = Image.open(BytesIO(body[end:]))
    alpha.load()

    out = rgb.convert("RGB")
    out.putalpha(alpha.convert("L"))
    return out


def _decode_body(body: bytes) -> tuple[Image.Image, float, str]:
    """Turn the response body into an RGBA cutout. Returns (image, ms, format).

    Sniffs the magic rather than trusting Content-Type: the framing is
    self-describing precisely so a proxy rewriting headers cannot break it, and
    this also means a box that predates the split format — or one where we
    turned it off — still decodes here with no negotiation.
    """
    t0 = time.perf_counter()
    try:
        if body[:len(SPLIT_MAGIC)] == SPLIT_MAGIC:
            img, wire = _decode_split(body), "split"
        else:
            img = Image.open(BytesIO(body))
            img.load()
            wire = (img.format or "?").lower()
    except SelfhostRembgError:
        raise
    except Exception as exc:
        raise SelfhostRembgError(f"undecodable result: {type(exc).__name__}: {exc}") from exc

    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return img, (time.perf_counter() - t0) * 1000, wire


def remove_background_selfhost(image: Image.Image) -> tuple[Image.Image, dict]:
    """
    Run background removal on our GPU box. Returns (RGBA cutout, metrics).

    Raises SelfhostRembgError for every failure mode — unconfigured, open
    breaker, timeout, HTTP error, undecodable body — so the caller has exactly
    one thing to catch before falling back to local.
    """
    base = (settings.BG_SERVICE_URL or "").strip().rstrip("/")
    if not base:
        raise SelfhostRembgError("BG_SERVICE_URL not configured")
    if _breaker.is_open():
        raise SelfhostRembgError(f"breaker open ({_breaker.seconds_remaining():.0f}s left)")

    timeout = (
        float(settings.BG_SERVICE_CONNECT_TIMEOUT_S),
        float(settings.BG_SERVICE_TIMEOUT_S),
    )
    raw, metrics = _encode_upload(image)
    want_split = bool(settings.BG_SERVICE_SPLIT)

    t0 = time.perf_counter()
    try:
        resp = requests.post(
            f"{base}/remove-bg",
            files={"file": ("capture.jpg", raw, "image/jpeg")},
            data={
                "refine_fg": "true",
                "response_type": "split" if want_split else "image",
            },
            timeout=timeout,
        )
    except requests.RequestException as exc:
        _breaker.record_failure()
        raise SelfhostRembgError(f"request failed: {type(exc).__name__}: {exc}") from exc

    metrics["request_ms"] = (time.perf_counter() - t0) * 1000
    # `elapsed` stops when response headers arrive — upload + queue + inference.
    # Whatever remains is pulling the cutout back down. Splitting the two says
    # whether a slow photo is the box being busy or the venue uplink being bad.
    metrics["ttfb_ms"] = resp.elapsed.total_seconds() * 1000
    metrics["download_ms"] = max(0.0, metrics["request_ms"] - metrics["ttfb_ms"])

    if resp.status_code != 200:
        _breaker.record_failure()
        # 503 is the box's "model not initialised yet" — it is still booting.
        raise SelfhostRembgError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    body = resp.content
    try:
        out, decode_ms, wire = _decode_body(body)
    except SelfhostRembgError:
        _breaker.record_failure()
        raise

    _breaker.record_success()
    metrics["decode_ms"] = decode_ms
    metrics["wire_format"] = wire
    metrics["download_kb"] = len(body) / 1024
    metrics["output_size"] = f"{out.width}x{out.height}"
    # Which box answered. Behind the NLB this is the only way to tell a
    # single-GPU day from a two-GPU one, and it costs a header.
    metrics["served_by"] = resp.headers.get("X-Served-By", "?")
    metrics["box_inference_ms"] = resp.headers.get("X-Inference-Time-Ms", "?")
    return out, metrics
