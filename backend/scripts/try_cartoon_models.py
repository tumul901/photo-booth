"""
Run every candidate cartoon model over a photo and time them.

    cd backend
    venv/Scripts/python.exe scripts/try_cartoon_models.py ../docs/test-photos/68.jpg

Writes one PNG per model to outputs/cartoon-try/ and prints a timing table.
Models live in backend/models/cartoon/ (gitignored, ~59MB, see download note).

Input alpha is preserved: the models take RGB, so a cutout is composited onto
white, stylised, then given its original alpha back.

LICENSING — matters before any of this ships:
  v2_*, v1_*  AnimeGANv2/v1 lineage, bryandlee's repo is MIT.
  v3_*        AnimeGANv3 is NON-COMMERCIAL. Evaluation only.
"""
import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = ROOT / "models" / "cartoon"
OUT_DIR = ROOT.parent / "outputs" / "cartoon-try"

# Layout differs by export toolchain, and nothing else does:
#   nchw   PyTorch export, (1,3,H,W), any size
#   nchw512  same but frozen at 512x512 by the export
#   nhwc   TensorFlow export, (1,H,W,3), any size
# All of them take RGB in [-1,1] and return RGB in [-1,1].
LAYOUT = {
    "v2_face_paint_512_v2": "nchw512",
    "v1_face_portrait": "nchw",
}  # everything else is nhwc


def to_32s(x: int) -> int:
    """Models are fully convolutional with stride-32 downsampling."""
    return 256 if x < 256 else x - x % 32


def stylise(session, layout: str, rgb: np.ndarray) -> np.ndarray:
    h, w = rgb.shape[:2]
    if layout == "nchw512":
        size = (512, 512)  # this export is frozen square; squash and unsquash
    else:
        size = (to_32s(w), to_32s(h))

    img = Image.fromarray(rgb).resize(size, Image.LANCZOS)
    x = np.asarray(img, np.float32) / 127.5 - 1.0

    if layout.startswith("nchw"):
        x = x.transpose(2, 0, 1)
    x = x[None]

    y = session.run(None, {session.get_inputs()[0].name: x})[0][0]
    if layout.startswith("nchw"):
        y = y.transpose(1, 2, 0)

    out = np.clip((y + 1.0) * 127.5, 0, 255).astype(np.uint8)
    return np.asarray(Image.fromarray(out).resize((w, h), Image.LANCZOS))


def main() -> None:
    src = Path(sys.argv[1] if len(sys.argv) > 1 else ROOT.parent / "docs/test-photos/68.jpg")
    models = sorted(MODEL_DIR.glob("*.onnx"))
    if not models:
        sys.exit(f"no models in {MODEL_DIR}")

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    img = Image.open(src)
    alpha = img.getchannel("A") if img.mode == "RGBA" else None
    # White, not black: a dark backdrop bleeds into the subject's edge and the
    # model inks a heavy dark rim that the real compositor would never produce.
    if alpha is not None:
        flat = Image.new("RGB", img.size, (255, 255, 255))
        flat.paste(img.convert("RGB"), mask=alpha)
    else:
        flat = img.convert("RGB")
    rgb = np.asarray(flat)

    print(f"\n{src.name}  {img.width}x{img.height}  alpha={'yes' if alpha else 'no'}\n")
    print(f"{'model':28s} {'ms':>7s}  output")
    print("-" * 64)

    for path in models:
        name = path.stem
        layout = LAYOUT.get(name, "nhwc")
        sess = ort.InferenceSession(str(path), providers=["CPUExecutionProvider"])

        stylise(sess, layout, rgb[:64, :64])  # warm up, so the first real run is honest
        t0 = time.perf_counter()
        out = stylise(sess, layout, rgb)
        ms = (time.perf_counter() - t0) * 1000

        result = Image.fromarray(out)
        if alpha is not None:
            result = result.convert("RGBA")
            result.putalpha(alpha)
        dest = OUT_DIR / f"{src.stem}__{name}.png"
        result.save(dest)
        print(f"{name:28s} {ms:7.0f}  {dest.name}")

    print(f"\nwrote {len(models)} files to {OUT_DIR}")


if __name__ == "__main__":
    main()
