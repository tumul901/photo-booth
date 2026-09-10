"""
Produce a single presentation image: paprika cartoon portrait, graded to the
theme, cut out on black, inside the neon triangle.

    cd backend
    venv/Scripts/python.exe scripts/make_demo_image.py <photo> [--sweep]

--sweep renders a few subject sizes side by side to pick from; without it the
chosen size is written as one finished PNG.
"""
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import services.rembg_service as rembg_mod
# The live profile stamps a blue stroke round the cutout for sticker mode. Under
# a cartoon render that reads as a printing error, so it is off for this path.
rembg_mod.get_sticker_effect = lambda: "none"

import asyncio

from services.cartoon_service import PRESETS, get_theme, make_duotone
from services.compose import compose_service
from services.geometric_overlays import compose_duotone_artwork
from services.rembg_service import rembg_service
from services.watercolor_service import add_rim_light
from try_cartoon_models import stylise
from try_paprika_tint import grade_pixels

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT.parent / "outputs" / "cartoon-try"
FRAME = ROOT.parent / "templates" / "cartoon-frame-portrait.png"

# Set to None to skip the cartoon styliser entirely and tint the real photo.
# The whole WORK_MAX dance below exists only to tame the model's hatching, so
# with no model the photo stays at full resolution and comes out sharper.
MODEL = None
THEME = "orange"
# Long edge the model runs at. See the note in build(). Ignored when MODEL is None.
WORK_MAX = 256
# "duotone" = strong, full luminance ramp onto the theme (shadow -> accent ->
# highlight). "grade" = the subtle hue-preserving pull used under a cartoon
# render. With no cartoon render the tint carries the whole look, so: duotone.
TINT = "duotone"
DUO_PRESET = "duo_standard"
GRADE = 0.62
RIM = 0.55
HEIGHT_RATIO = 0.44
CENTER_Y = 0.58


TIMINGS: dict[str, float] = {}


def _rss_mb() -> float:
    """Current process resident memory, or 0 if psutil isn't available."""
    try:
        import psutil
        return psutil.Process().memory_info().rss / 1e6
    except Exception:
        return 0.0


def build(photo: Path) -> tuple[np.ndarray, np.ndarray]:
    """Cut the subject out and stylise it. Returns (styled RGB, alpha)."""
    base_rss = _rss_mb()

    t = time.perf_counter()
    cutout = asyncio.run(rembg_service.remove_background(photo.read_bytes()))
    TIMINGS["rembg (cloud BiRefNet)"] = time.perf_counter() - t

    # Trim to the subject before composing. The compositor centres the IMAGE, so
    # a guest standing off-centre in their own frame lands off-centre in the
    # triangle; trimming to the subject's own pixels makes "centred" mean the
    # person. Purely framing — it does not change the style.
    cutout = compose_service.crop_to_alpha_bbox(cutout)
    alpha = np.asarray(cutout.getchannel("A"))

    # Composite onto white before the model, never black: the model inks a dark
    # rim wherever it meets a dark field, and that rim survives into the alpha
    # edge as a dirty halo once the subject is placed on the black backdrop.
    flat = Image.new("RGB", cutout.size, (255, 255, 255))
    flat.paste(cutout.convert("RGB"), mask=cutout.getchannel("A"))

    if MODEL is None:
        TIMINGS["_work_size"] = f"{flat.width}x{flat.height} (no model)"
        TIMINGS["_rss_base_mb"] = base_rss
        TIMINGS["_rss_peak_mb"] = _rss_mb()
        TIMINGS["_input_px"] = float(cutout.width * cutout.height)
        TIMINGS["_input_size"] = f"{cutout.width}x{cutout.height}"
        return np.asarray(flat), alpha

    t = time.perf_counter()
    sess = ort.InferenceSession(str(ROOT / f"models/cartoon/{MODEL}.onnx"),
                                providers=["CPUExecutionProvider"])
    TIMINGS["onnx session load"] = time.perf_counter() - t
    rss_loaded = _rss_mb()

    # Cap what the model sees. AnimeGAN inks luminance ridges, and the ridges it
    # finds on a real capture are pores, blemishes and JPEG blocking, which it
    # draws as hatching across the forehead and cheeks. The artefact scales with
    # input pixels — at 2x input the whole face crackles — so the fix is to run
    # the model small and enlarge its output. Cel-shaded flats survive that;
    # pre-smoothing instead does not work, because a blur strong enough to erase
    # skin texture erases the eyes first.
    src = np.asarray(flat)
    h, w = src.shape[:2]
    if max(h, w) > WORK_MAX:
        s = WORK_MAX / max(h, w)
        src = cv2.resize(src, (max(int(w * s), 1), max(int(h * s), 1)), interpolation=cv2.INTER_AREA)

    t = time.perf_counter()
    art = stylise(sess, "nhwc", src)
    TIMINGS[f"{MODEL} inference"] = time.perf_counter() - t
    TIMINGS["_work_size"] = f"{src.shape[1]}x{src.shape[0]}"

    if art.shape[:2] != (h, w):
        art = cv2.resize(art, (w, h), interpolation=cv2.INTER_LANCZOS4)

    TIMINGS["_rss_base_mb"] = base_rss
    TIMINGS["_rss_peak_mb"] = max(rss_loaded, _rss_mb())
    TIMINGS["_input_px"] = float(cutout.width * cutout.height)
    TIMINGS["_input_size"] = f"{cutout.width}x{cutout.height}"
    return art, alpha


def compose(art: np.ndarray, alpha: np.ndarray, height_ratio: float) -> Image.Image:
    palette = get_theme(THEME)
    if TINT == "duotone":
        # Full luminance -> shadow/accent/highlight ramp. This is the strong one:
        # grade_pixels deliberately preserves each pixel's hue, so it cannot push
        # a green shirt orange no matter how far it is turned up.
        rgba = Image.fromarray(np.dstack([art, alpha]), "RGBA")
        canvas = np.array(make_duotone(rgba, THEME, **PRESETS[DUO_PRESET]).convert("RGB"))
    else:
        canvas = grade_pixels(art, THEME, GRADE).copy()
    add_rim_light(canvas, alpha, THEME, strength=RIM)
    subject = Image.fromarray(np.dstack([canvas, alpha]), "RGBA")
    return compose_duotone_artwork(
        subject,
        triangle_color=palette["triangle"],
        bg_color=(0, 0, 0),            # pure black behind the cutout, as asked
        match_frame_backdrop=False,    # or the frame's own near-black wins
        frame_path=str(FRAME) if FRAME.exists() else None,
        fit="portrait",
        subject_height_ratio=height_ratio,
        subject_center_y_ratio=CENTER_Y,
    )


def main() -> None:
    photo = Path(sys.argv[1])
    art, alpha = build(photo)
    OUT.mkdir(parents=True, exist_ok=True)

    if "--sweep" in sys.argv:
        ratios = (0.50, 0.62, 0.74, 0.86)
        CW, CH, PAD, LBL = 300, 375, 10, 24
        sheet = Image.new("RGB", (len(ratios) * (CW + PAD) + PAD, CH + LBL + 2 * PAD), (24, 24, 28))
        dr = ImageDraw.Draw(sheet)
        for i, r in enumerate(ratios):
            im = compose(art, alpha, r).convert("RGB").resize((CW, CH), Image.LANCZOS)
            x = PAD + i * (CW + PAD)
            sheet.paste(im, (x, PAD))
            dr.text((x + 2, PAD + CH + 5), f"height={r:.2f}", fill=(235, 235, 240))
        dest = OUT / "_SHEET_demo.png"
        sheet.save(dest)
    else:
        dest = OUT / f"DEMO_{photo.stem}.png"
        t = time.perf_counter()
        compose(art, alpha, HEIGHT_RATIO).save(dest)
        TIMINGS["grade + rim + compose"] = time.perf_counter() - t

    print(f"wrote {dest}")

    stages = {k: v for k, v in TIMINGS.items() if not k.startswith("_")}
    print(f"\n--- cost, input {TIMINGS['_input_size']} "
          f"({TIMINGS['_input_px'] / 1e6:.2f}MP) ---")
    for k, v in stages.items():
        print(f"  {k:26s} {v * 1000:7.0f} ms")
    print(f"  {'TOTAL':26s} {sum(stages.values()) * 1000:7.0f} ms")
    print(f"  rss {TIMINGS['_rss_base_mb']:.0f}MB -> {TIMINGS['_rss_peak_mb']:.0f}MB")


if __name__ == "__main__":
    main()
