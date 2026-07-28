"""
fal.ai round-trip timing benchmark (dev tool, never imported by the app)
=======================================================================
Measures where the wall clock actually goes on a cloud cutout, measured the same
way on every machine so a dev box and the VPS can be compared fairly. Booth
latency is dominated by the network leg, not the GPU, and that leg is exactly
what differs between a laptop on home wifi and a datacentre VPS.

    # local (from backend/)
    python scripts/fal_timing.py --runs 5

    # on the VPS, inside the container so it uses the booth's real network path
    docker compose exec backend python scripts/fal_timing.py --runs 5

Stages reported per run:
    encode    downscale + JPEG encode, on this machine
    ttfb      upload + fal queue + GPU inference (until response headers arrive)
    download  pulling the PNG result body back down
    decode    base64 -> PIL

Uses photo-like noise by default so the JPEG payload is a realistic size; pass
--image to time a real capture instead.
"""

import argparse
import os
import platform
import statistics
import sys
import time
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(BACKEND_ROOT))
os.chdir(BACKEND_ROOT)  # so config.py finds .env regardless of where this is run from

import numpy as np
from PIL import Image, ImageFilter

from services import cloud_rembg
from services.cloud_rembg import CloudRembgError, is_configured, remove_background_cloud

STAGES = ("encode_ms", "ttfb_ms", "download_ms", "decode_ms", "total_ms")


def _synthetic_capture(width: int = 1080, height: int = 1440) -> Image.Image:
    """Blurred noise. A flat image would compress to almost nothing and make the
    upload leg look far faster than a real photo ever will."""
    rng = np.random.default_rng(0)
    arr = rng.integers(0, 256, (height, width, 3), dtype=np.uint8)
    return Image.fromarray(arr).filter(ImageFilter.GaussianBlur(2))


def main() -> int:
    ap = argparse.ArgumentParser(description="Time the fal.ai BiRefNet round trip.")
    ap.add_argument("--runs", type=int, default=5, help="number of calls (default 5)")
    ap.add_argument("--model", default="Matting", help="fal model variant (default Matting)")
    ap.add_argument("--resolution", default="1024x1024", help="operating_resolution")
    ap.add_argument("--format", default="png", choices=["png", "webp"], help="output_format")
    ap.add_argument("--image", help="real capture to time; synthetic noise if omitted")
    ap.add_argument(
        "--max-dim",
        type=int,
        help=f"override upload downscale cap (default {cloud_rembg.MAX_UPLOAD_DIM})",
    )
    args = ap.parse_args()

    if args.max_dim:
        cloud_rembg.MAX_UPLOAD_DIM = args.max_dim

    where = "docker" if Path("/.dockerenv").exists() else "host"
    print(f"host={platform.node()} ({where}) python={platform.python_version()}")
    print(f"model={args.model} resolution={args.resolution} format={args.format} runs={args.runs}")

    if not is_configured():
        print("\nFAL_KEY not configured — nothing to measure.")
        return 1

    src = Image.open(args.image) if args.image else _synthetic_capture()
    label = f"file:{args.image}" if args.image else "synthetic"
    print(f"source={label} {src.width}x{src.height}\n")

    rows: list[dict] = []
    for i in range(1, args.runs + 1):
        t0 = time.perf_counter()
        try:
            _, m = remove_background_cloud(
                src,
                fal_model=args.model,
                operating_resolution=args.resolution,
                output_format=args.format,
            )
        except CloudRembgError as exc:
            print(f"  run {i}: FAILED — {exc}")
            continue
        m["total_ms"] = (time.perf_counter() - t0) * 1000
        rows.append(m)
        print(
            f"  run {i}: total={m['total_ms']:6.0f}ms  encode={m['encode_ms']:5.0f}  "
            f"ttfb={m['ttfb_ms']:6.0f}  download={m['download_ms']:5.0f}  "
            f"decode={m['decode_ms']:4.0f}   upload={m['upload_kb']:.0f}KB"
        )

    if not rows:
        print("\nAll runs failed.")
        return 1

    print(f"\n{'stage':<10}{'min':>9}{'median':>9}{'max':>9}   (ms, n={len(rows)})")
    print("-" * 46)
    for stage in STAGES:
        vals = [r[stage] for r in rows]
        name = stage[:-3]
        print(f"{name:<10}{min(vals):>9.0f}{statistics.median(vals):>9.0f}{max(vals):>9.0f}")

    med_total = statistics.median([r["total_ms"] for r in rows])
    med_ttfb = statistics.median([r["ttfb_ms"] for r in rows])
    print(
        f"\nmedian round trip {med_total / 1000:.2f}s — {100 * med_ttfb / med_total:.0f}% of it "
        f"is upload+inference (ttfb), payload {rows[0]['upload_kb']:.0f}KB up / "
        f"{rows[0]['output_size']} {args.format} down (upload cap {cloud_rembg.MAX_UPLOAD_DIM}px)"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
