"""
Preview the paprika cartoon model graded to a theme and dropped in the triangle.

    cd backend
    venv/Scripts/python.exe scripts/try_paprika_tint.py

The point of the sweep: paprika already produces its own colour, so the theme has
to be applied as a GRADE (a partial pull toward the accent that keeps each
pixel's hue) rather than as make_duotone's full luminance->ramp mapping, which
would discard everything the model produced. grade=0 is the control.

Formula is lifted from watercolor_service._build_region_ramp, applied per pixel
instead of per ramp step. Grading pixels is wrong there because it would undo
that renderer's quantisation; here there is no quantisation of ours to protect,
so it is the right place for it.
"""
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from services.cartoon_service import get_theme
from services.geometric_overlays import compose_duotone_artwork
from services.watercolor_service import add_rim_light
from try_cartoon_models import stylise

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "outputs" / "cartoon-try"
FRAME = ROOT.parent / "templates" / "cartoon-frame-portrait.png"

GRADES = (0.0, 0.15, 0.30, 0.50)
THEME = "orange"


def grade_pixels(rgb: np.ndarray, theme: str, amount: float) -> np.ndarray:
    """Pull lights toward the accent and darks toward the backdrop, keeping hue."""
    if amount <= 0:
        return rgb
    palette = get_theme(theme)
    accent = np.array(palette["accent"], np.float32)
    shade = np.array(palette["backdrop"], np.float32)

    col = rgb.astype(np.float32)
    lum = (col @ np.array([0.299, 0.587, 0.114], np.float32))[..., None] / 255.0
    target = shade + (accent - shade) * lum
    return np.clip(col + (target - col) * (amount * lum), 0, 255).astype(np.uint8)


def main() -> None:
    cutout = Image.open(OUT / "_cutout.png").convert("RGBA")
    alpha = np.asarray(cutout.getchannel("A"))

    flat = Image.new("RGB", cutout.size, (255, 255, 255))
    flat.paste(cutout.convert("RGB"), mask=cutout.getchannel("A"))

    sess = ort.InferenceSession(str(ROOT / "models/cartoon/v2_paprika.onnx"),
                                providers=["CPUExecutionProvider"])
    art = stylise(sess, "nhwc", np.asarray(flat))

    palette = get_theme(THEME)
    panels = []
    for g in GRADES:
        for rim in (0.0, 0.55):
            canvas = grade_pixels(art, THEME, g).copy()
            if rim:
                add_rim_light(canvas, alpha, THEME, strength=rim)
            subject = Image.fromarray(np.dstack([canvas, alpha]), "RGBA")
            composed = compose_duotone_artwork(
                subject,
                triangle_color=palette["triangle"],
                bg_color=palette["backdrop"],
                frame_path=str(FRAME) if FRAME.exists() else None,
                fit="portrait",
            )
            panels.append((f"grade={g:.2f} rim={rim:.2f}", composed))

    CW, CH, PAD, LBL = 300, 375, 10, 24
    cols = 4
    rows = (len(panels) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * (CW + PAD) + PAD, rows * (CH + LBL + PAD) + PAD), (24, 24, 28))
    dr = ImageDraw.Draw(sheet)
    for i, (label, im) in enumerate(panels):
        im = im.convert("RGB").resize((CW, CH), Image.LANCZOS)
        x = PAD + (i % cols) * (CW + PAD)
        y = PAD + (i // cols) * (CH + LBL + PAD)
        sheet.paste(im, (x, y))
        dr.text((x + 2, y + CH + 5), label, fill=(235, 235, 240))

    dest = OUT / "_SHEET_tint.png"
    sheet.save(dest)
    print(f"wrote {dest}  {sheet.size}")


if __name__ == "__main__":
    main()
