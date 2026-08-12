"""
Smoke test for the cartoon (duotone portrait) artwork pipeline.

Run from the backend/ directory:
    PYTHONIOENCODING=utf-8 python test_cartoon.py

Covers the failures this feature has actually hit:
  - a face rendering as a flat blob with no modelling (the duotone equivalent of
    the old empty-silhouette bug) — caught by tonal spread, not by "did it run"
  - small/dim webcam captures losing all detail to upscaling before processing
  - the guest-framed path re-cropping and discarding the guest's composition
  - themes producing the wrong hue family
"""
import sys
import time

sys.path.insert(0, ".")

from PIL import Image
import numpy as np
import cv2

from services.cartoon_service import (
    duotone_preset, portrait_crop, get_theme, PRESETS, THEMES, DEFAULT_PRESET,
)
from services.geometric_overlays import compose_duotone_artwork
from services.face_service import face_service

TEST_IMAGE = "../templates/photobooth (1).jpg.jpeg"
OUT_DIR = "../outputs"

# A portrait with real modelling shows meaningful luminance variation across the
# subject. A flat blob sits near zero.
MIN_TONAL_SPREAD = 18.0

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"   {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def tonal_spread(art: Image.Image, subject: Image.Image) -> float:
    """Std-dev of luminance inside the subject — how much modelling survived."""
    lum = np.array(art.convert("L"))
    a = np.array(subject.getchannel("A"))
    if a.shape != lum.shape:
        a = cv2.resize(a, (lum.shape[1], lum.shape[0]), interpolation=cv2.INTER_NEAREST)
    subj = a > 140
    return float(lum[subj].std()) if subj.any() else 0.0


def dominant_hue(art: Image.Image, subject: Image.Image) -> float:
    """Median OpenCV hue (0-179) of coloured pixels inside the subject."""
    hsv = cv2.cvtColor(np.array(art.convert("RGB")), cv2.COLOR_RGB2HSV)
    a = np.array(subject.getchannel("A"))
    if a.shape != hsv.shape[:2]:
        a = cv2.resize(a, (hsv.shape[1], hsv.shape[0]), interpolation=cv2.INTER_NEAREST)
    sel = (a > 140) & (hsv[:, :, 1] > 60) & (hsv[:, :, 2] > 40)
    return float(np.median(hsv[:, :, 0][sel])) if sel.any() else -1.0


def simulate_capture(img: Image.Image, w: int = 576, h: int = 720, dim: bool = False) -> Image.Image:
    """Approximate a real booth capture: small webcam frame, optionally dim/flat."""
    small = img.resize((w, h), Image.LANCZOS)
    if dim:
        arr = np.array(small).astype(np.float32)
        arr[:, :, :3] = arr[:, :, :3] * 0.55 + 40
        small = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGBA")
    return small


print("=" * 66)
print("CARTOON / DUOTONE PORTRAIT PIPELINE — SMOKE TEST")
print("=" * 66)

print(f"\n1. Load source: {TEST_IMAGE}")
src = Image.open(TEST_IMAGE).convert("RGBA")
print(f"   {src.width}x{src.height}")
landmarks = face_service.detect_landmarks(src)
print(f"   landmarks: {'found' if landmarks else 'none'}")

print("\n2. Portrait crop")
cropped = portrait_crop(src, landmarks)
check("crop is non-empty", cropped.width > 0 and cropped.height > 0,
      f"{cropped.width}x{cropped.height}")

print("\n3. Every preset keeps real tonal modelling")
for name in PRESETS:
    t0 = time.perf_counter()
    art = duotone_preset(src, preset=name, landmarks=landmarks)
    elapsed = (time.perf_counter() - t0) * 1000
    spread = tonal_spread(art, art)
    check(f"preset '{name}'", spread >= MIN_TONAL_SPREAD and art.mode == "RGBA",
          f"tonal spread={spread:.1f} (>= {MIN_TONAL_SPREAD} expected), {elapsed:.0f}ms")

print("\n4. Every theme renders in its own hue family")
# Expected OpenCV hues (0-179): orange ~12, blue ~105, magenta ~140, green ~70, violet ~130
EXPECTED_HUE = {"orange": 12, "blue": 105, "magenta": 140, "green": 70, "violet": 130}
for theme in THEMES:
    art = duotone_preset(src, preset=DEFAULT_PRESET, theme=theme, landmarks=landmarks)
    hue = dominant_hue(art, art)
    want = EXPECTED_HUE[theme]
    # Hue is circular; compare on the shorter arc
    delta = min(abs(hue - want), 180 - abs(hue - want)) if hue >= 0 else 999
    check(f"theme '{theme}'", delta <= 20, f"hue={hue:.0f} expected~{want} (delta {delta:.0f})")
    compose_duotone_artwork(
        art, triangle_color=get_theme(theme)["triangle"], bg_color=get_theme(theme)["backdrop"]
    ).save(f"{OUT_DIR}/test_duotone_{theme}.png")

print("\n5. Unknown preset / theme fall back instead of raising")
try:
    art_bad = duotone_preset(src, preset="nope", theme="chartreuse", landmarks=landmarks)
    check("unknown names handled", art_bad.mode == "RGBA")
except Exception as e:
    check("unknown names handled", False, str(e))

print("\n6. Guest-framed mode preserves the captured framing")
framed = duotone_preset(src, preset=DEFAULT_PRESET, landmarks=landmarks, auto_crop=False)
check("aspect ratio preserved",
      abs((src.width / src.height) - (framed.width / framed.height)) < 0.02,
      f"in={src.width / src.height:.3f} out={framed.width / framed.height:.3f}")
framed_art = compose_duotone_artwork(framed, fit="frame")
check("frame fit fills the canvas", (framed_art.width, framed_art.height) == (1080, 1350),
      f"{framed_art.width}x{framed_art.height}")
framed_art.save(f"{OUT_DIR}/test_duotone_guest_framed.png")

print("\n7. Small / dim captures still show modelling")
for label, dim in (("576x720 normal light", False), ("576x720 dim / flat", True)):
    cap = simulate_capture(src, dim=dim)
    art_cap = duotone_preset(cap, preset=DEFAULT_PRESET, landmarks=None,
                             auto_crop=False, render_height=1350)
    spread = tonal_spread(art_cap, cap)
    check(f"tonal detail — {label}", spread >= MIN_TONAL_SPREAD,
          f"spread={spread:.1f} (>= {MIN_TONAL_SPREAD} expected)")

print("\n8. Small captures are never upscaled before processing")
tiny = simulate_capture(src, w=480, h=600)
art_tiny = duotone_preset(tiny, preset=DEFAULT_PRESET, landmarks=None,
                          auto_crop=False, render_height=1350)
check("render stays at capture size", art_tiny.height <= 600,
      f"asked for 1350, rendered at {art_tiny.width}x{art_tiny.height}")

print("\n9. Frame matte clips the portrait to the triangle")
# The frame PNG is opaque except for the triangle window. Compositing it last
# must leave NO subject pixels outside that window — this is what guarantees
# "nothing goes outside the triangle" without any geometry maths at render time.
import os
FRAMES = {
    "cartoon-frame-square.png": (1080, 1080),
    "cartoon-frame-wide.png": (1920, 1072),
    "cartoon-frame-portrait.png": (1080, 1350),
    # Blue colourway — same geometry, so every guarantee above must hold for it too
    "cartoon-frame-square-blue.png": (1080, 1080),
    "cartoon-frame-wide-blue.png": (1920, 1072),
    "cartoon-frame-portrait-blue.png": (1080, 1350),
}
for fname, (fw, fh) in FRAMES.items():
    fpath = f"../templates/{fname}"
    if not os.path.exists(fpath):
        check(f"{fname} exists", False, "missing")
        continue

    frame_img = Image.open(fpath).convert("RGBA")
    check(f"{fname} is canvas-sized", (frame_img.width, frame_img.height) == (fw, fh),
          f"{frame_img.width}x{frame_img.height} expected {fw}x{fh}")

    fa = np.array(frame_img.getchannel("A"))
    window = fa < 128
    check(f"{fname} has a transparent window", window.any(),
          f"{window.mean() * 100:.1f}% of the canvas open")

    # Composite a fully-opaque bright subject and confirm it only shows through
    loud = Image.new("RGBA", (fw, fh), (255, 0, 255, 255))
    out = np.array(compose_duotone_artwork(
        loud, canvas_width=fw, canvas_height=fh, frame_path=os.path.abspath(fpath), fit="frame",
    ))
    leaked = (out[:, :, 0] > 200) & (out[:, :, 1] < 80) & (out[:, :, 2] > 200)
    outside = leaked & ~window
    check(f"{fname} leaks nothing outside the window", outside.sum() == 0,
          f"{outside.sum()} stray px")
    check(f"{fname} shows the subject inside", leaked[window].mean() > 0.8,
          f"{leaked[window].mean() * 100:.0f}% of the window filled")

print("\n10. Blue carries the same amount of tint as orange")
# The blue theme is orange rotated in hue with saturation and value untouched.
# Rendering one subject through both and differencing in HSV proves it on real
# pixels rather than on the palette constants: if S or V had drifted, blue would
# read as a weaker or stronger tint than orange rather than simply a different one.
pair = {}
for theme in ("orange", "blue"):
    art = duotone_preset(src, preset=DEFAULT_PRESET, theme=theme, landmarks=landmarks)
    pair[theme] = cv2.cvtColor(np.array(art.convert("RGB")), cv2.COLOR_RGB2HSV).astype(np.float32)

a_ch = np.array(duotone_preset(src, preset=DEFAULT_PRESET, landmarks=landmarks).getchannel("A"))
subj = a_ch > 140
o, b = pair["orange"], pair["blue"]

ds = float(np.abs(o[:, :, 1] - b[:, :, 1])[subj].mean())
dv = float(np.abs(o[:, :, 2] - b[:, :, 2])[subj].mean())
check("saturation identical to orange", ds <= 1.0, f"mean |dS| = {ds:.2f}/255 (<= 1.0 expected)")
check("value identical to orange", dv <= 1.0, f"mean |dV| = {dv:.2f}/255 (<= 1.0 expected)")

# ...and the hue offset must be one consistent rotation, not a per-tone remix
coloured = subj & (o[:, :, 1] > 40) & (b[:, :, 1] > 40)
rot = (b[:, :, 0] - o[:, :, 0])[coloured] % 180
check("a single consistent hue rotation", float(rot.std()) <= 3.0,
      f"+{float(np.median(rot)) * 2:.0f}deg, spread {float(rot.std()) * 2:.1f}deg (<= 6 expected)")

print("\n11. Fully-transparent input degrades gracefully")
try:
    blank = Image.new("RGBA", (400, 500), (0, 0, 0, 0))
    check("blank input handled",
          duotone_preset(blank, preset=DEFAULT_PRESET, landmarks=None).mode == "RGBA")
except Exception as e:
    check("blank input handled", False, str(e))

print("\n" + "=" * 66)
if failures:
    print(f"FAILED — {len(failures)} check(s): {', '.join(failures)}")
    sys.exit(1)
print("ALL CHECKS PASSED")
print("=" * 66)
