"""
Cloud Background Removal — fal.ai BiRefNet v2
=============================================
GPU-hosted BiRefNet, used by the ``cloud_birefnet_*`` profiles in
``rembg_service``. It exists because the local u2net/isnet models have plateaued
on hair wisps and busy backgrounds, and every SOTA local model is either far too
slow (~23 s/photo) or OOM-crashes on this CPU-only box (tested 2026-06-29).

Contract with the caller: **never raise anything but CloudRembgError**, and raise
it fast. ``rembg_service`` catches it and runs the local pipeline instead, so a
dead venue uplink costs quality but never stalls the booth.

Request shape (schema: https://fal.ai/models/fal-ai/birefnet/v2/api):

    POST https://fal.run/fal-ai/birefnet/v2
    Authorization: Key <FAL_KEY>
    {
      "image_url": "data:image/jpeg;base64,...",  # inline, no fal-storage upload
      "model": "Portrait" | "Matting" | "General Use (Heavy)" | ...,
      "operating_resolution": "1024x1024" | "2048x2048",
      "output_format": "png",
      "refine_foreground": true,                  # matted, decontaminated edges
      "sync_mode": true                           # result inline as a data URI
    }
    -> {"image": {"url": "data:image/png;base64,...", "width": .., "height": ..}}

``sync_mode`` plus the ``fal.run`` host (rather than ``queue.fal.run``) makes this
a single round trip: no polling, no second download.
"""

import base64
import binascii
import threading
import time
from io import BytesIO

import requests
from PIL import Image

from config import settings

# BiRefNet operates internally at 1024 or 2048 px, so uploading more than this is
# pure venue-uplink tax for no quality gain. 1200 measured ~0.5 s faster end-to-end
# than 1600 (316 KB vs 562 KB upload) with no visible edge difference, and it matches
# human_hi's max_input so a cutout is the same resolution whether cloud or the local
# fallback produced it. See scripts/fal_timing.py.
MAX_UPLOAD_DIM = 1200
JPEG_QUALITY = 90

# Consecutive failures before we stop calling fal, and how long we stay off.
# Without this, a dead uplink adds the full timeout to *every* guest's wait.
_BREAKER_THRESHOLD = 3
_BREAKER_COOLDOWN_S = 60.0


class CloudRembgError(RuntimeError):
    """Any cloud failure. Always caught by rembg_service, which falls back local."""


class _CircuitBreaker:
    """Trips after N consecutive failures, then half-opens after a cool-down."""

    def __init__(self, threshold: int, cooldown_s: float):
        self._threshold = threshold
        self._cooldown_s = cooldown_s
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._open_until = 0.0

    def is_open(self) -> bool:
        with self._lock:
            if self._open_until and time.monotonic() >= self._open_until:
                # Cool-down elapsed — half-open: let the next call through to probe.
                self._open_until = 0.0
                self._consecutive_failures = 0
            return self._open_until > 0.0

    def seconds_remaining(self) -> float:
        with self._lock:
            return max(0.0, self._open_until - time.monotonic())

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._open_until = 0.0

    def record_failure(self) -> None:
        with self._lock:
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._threshold:
                self._open_until = time.monotonic() + self._cooldown_s
                print(
                    f"CLOUD-BREAKER open for {self._cooldown_s:.0f}s after "
                    f"{self._consecutive_failures} consecutive failures",
                    flush=True,
                )


_breaker = _CircuitBreaker(_BREAKER_THRESHOLD, _BREAKER_COOLDOWN_S)


def is_configured() -> bool:
    """True when a FAL_KEY is present. Surfaced to the admin panel so a cloud
    profile can't be selected while silently running local."""
    return bool((settings.FAL_KEY or "").strip())


def breaker_open() -> bool:
    """Whether cloud calls are currently being skipped (admin status display)."""
    return _breaker.is_open()


def _encode_upload(image: Image.Image) -> tuple[str, dict]:
    """Downscale + JPEG-encode to an inline data URI. Returns (uri, metrics)."""
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
    uri = "data:image/jpeg;base64," + base64.b64encode(raw).decode("ascii")
    return uri, {
        "encode_ms": (time.perf_counter() - t0) * 1000,
        "did_downsize": did_downsize,
        "input_size": f"{img.width}x{img.height}",
        "input_megapixels": (img.width * img.height) / 1_000_000,
        "upload_kb": len(raw) / 1024,
    }


def _decode_result(payload: dict, timeout_s: float) -> tuple[Image.Image, float]:
    """Turn a fal response into an RGBA cutout. Returns (image, decode_ms)."""
    t0 = time.perf_counter()
    url = (payload.get("image") or {}).get("url")
    if not url:
        raise CloudRembgError(f"malformed response (no image.url): {str(payload)[:200]}")

    if url.startswith("data:"):
        _, _, b64 = url.partition(",")
        try:
            data = base64.b64decode(b64)
        except (binascii.Error, ValueError) as exc:
            raise CloudRembgError(f"bad data URI: {exc}") from exc
    else:
        # sync_mode should inline the result; a hosted URL means fal spilled to
        # storage anyway (e.g. oversized payload) — fetch it rather than fail.
        try:
            resp = requests.get(url, timeout=timeout_s)
            resp.raise_for_status()
            data = resp.content
        except requests.RequestException as exc:
            raise CloudRembgError(f"result download failed: {exc}") from exc

    try:
        img = Image.open(BytesIO(data))
        img.load()
    except Exception as exc:
        raise CloudRembgError(f"undecodable result image: {exc}") from exc

    if img.mode != "RGBA":
        img = img.convert("RGBA")
    return img, (time.perf_counter() - t0) * 1000


def remove_background_cloud(
    image: Image.Image,
    *,
    fal_model: str,
    operating_resolution: str = "1024x1024",
    output_format: str = "png",
) -> tuple[Image.Image, dict]:
    """
    Run BiRefNet v2 on fal.ai. Returns (RGBA cutout, metrics).

    Raises CloudRembgError for every failure mode — missing key, open breaker,
    timeout, HTTP error, undecodable image — so the caller has exactly one thing
    to catch before falling back to local.
    """
    key = (settings.FAL_KEY or "").strip()
    if not key:
        raise CloudRembgError("FAL_KEY not configured")
    if _breaker.is_open():
        raise CloudRembgError(f"breaker open ({_breaker.seconds_remaining():.0f}s left)")

    timeout_s = float(settings.FAL_TIMEOUT_S)
    uri, metrics = _encode_upload(image)
    metrics["fal_model"] = fal_model

    t0 = time.perf_counter()
    try:
        resp = requests.post(
            settings.FAL_ENDPOINT,
            json={
                "image_url": uri,
                "model": fal_model,
                "operating_resolution": operating_resolution,
                "output_format": output_format,
                "refine_foreground": True,
                "sync_mode": True,
            },
            headers={
                "Authorization": f"Key {key}",
                "Content-Type": "application/json",
            },
            timeout=timeout_s,
        )
    except requests.RequestException as exc:
        _breaker.record_failure()
        raise CloudRembgError(f"request failed: {type(exc).__name__}: {exc}") from exc
    metrics["request_ms"] = (time.perf_counter() - t0) * 1000
    # `elapsed` stops when response headers arrive — i.e. upload + queue + inference.
    # Whatever remains is pulling the PNG body back down. Splitting the two tells us
    # whether a slow photo is fal being busy or the venue uplink being bad.
    metrics["ttfb_ms"] = resp.elapsed.total_seconds() * 1000
    metrics["download_ms"] = max(0.0, metrics["request_ms"] - metrics["ttfb_ms"])

    if resp.status_code != 200:
        _breaker.record_failure()
        raise CloudRembgError(f"HTTP {resp.status_code}: {resp.text[:200]}")

    try:
        payload = resp.json()
    except ValueError as exc:
        _breaker.record_failure()
        raise CloudRembgError(f"non-JSON response: {exc}") from exc

    try:
        out, decode_ms = _decode_result(payload, timeout_s)
    except CloudRembgError:
        _breaker.record_failure()
        raise

    _breaker.record_success()
    metrics["decode_ms"] = decode_ms
    metrics["output_size"] = f"{out.width}x{out.height}"
    return out, metrics
