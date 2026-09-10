"""
Kill the wrinkle-like strokes paprika draws across skin.

    cd backend
    venv/Scripts/python.exe scripts/try_skin_smooth.py <photo>

AnimeGAN inks luminance ridges. On a small, compressed capture the ridges it
finds are pores, blemishes and JPEG blocking, so it draws them as hatching
across the forehead and cheeks. Two levers, tested here together:

  presmooth  bilateral passes before the model — removes the texture while
             keeping the real edges (jaw, glasses, hairline) the model needs.
  upscale    run the model on an enlarged input. Skin texture then occupies more
             pixels than the model's edge kernel, so it stops reading as an edge,
             and the strokes it does draw are finer relative to the output.

Writes a face-crop comparison, because at full-canvas size the artefact is too
small to judge.
"""
import sys
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.rembg_service as rembg_mod
rembg_mod.get_sticker_effect = lambda: "none"

import asyncio

from services.rembg_service import rembg_service
from try_cartoon_models import stylise

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "outputs" / "cartoon-try"

# (label, bilateral passes, sigma, input scale)
VARIANTS = [
    ("control 1.0x", 0, 0, 1.0),
    ("0.75x", 0, 0, 0.75),
    ("0.5x", 0, 0, 0.5),
    ("0.5x + smooth", 1, 45, 0.5),
    ("0.375x", 0, 0, 0.375),
    ("1.0x heavy smooth", 3, 75, 1.0),
]


def main() -> None:
    photo = Path(sys.argv[1])
    cutout = asyncio.run(rembg_service.remove_background(photo.read_bytes()))
    flat = Image.new("RGB", cutout.size, (255, 255, 255))
    flat.paste(cutout.convert("RGB"), mask=cutout.getchannel("A"))
    base = np.asarray(flat)

    sess = ort.InferenceSession(str(ROOT / "models/cartoon/v2_paprika.onnx"),
                                providers=["CPUExecutionProvider"])

    panels = []
    for label, passes, sigma, scale in VARIANTS:
        img = base
        if scale != 1.0:
            img = cv2.resize(img, None, fx=scale, fy=scale, interpolation=cv2.INTER_CUBIC)
        for _ in range(passes):
            img = cv2.bilateralFilter(img, 9, sigma, sigma)
        panels.append((label, stylise(sess, "nhwc", img)))

    # Crop the upper face, where the hatching actually shows.
    CW = 460
    tiles = []
    for label, art in panels:
        h, w = art.shape[:2]
        face = art[int(h * 0.10):int(h * 0.62), int(w * 0.18):int(w * 0.82)]
        im = Image.fromarray(face)
        im = im.resize((CW, int(CW * im.height / im.width)), Image.LANCZOS)
        tiles.append((label, im))

    CH = max(t.height for _, t in tiles)
    PAD, LBL, cols = 10, 24, 3
    rows = (len(tiles) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (CW + PAD) + PAD, rows * (CH + LBL + PAD) + PAD), (24, 24, 28))
    dr = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(tiles):
        x = PAD + (i % cols) * (CW + PAD)
        y = PAD + (i // cols) * (CH + LBL + PAD)
        sheet.paste(im, (x, y))
        dr.text((x + 2, y + CH + 5), label, fill=(235, 235, 240))

    dest = OUT / "_SHEET_smooth.png"
    sheet.save(dest)
    print(f"wrote {dest}")


if __name__ == "__main__":
    main()
