"""
Smoke test for the watercolor (illustrated portrait) pipeline.

Run from the backend/ directory:
    PYTHONIOENCODING=utf-8 python test_watercolor.py

Covers the failures this kind of renderer actually hits, several of which this
project has already been burned by once:

  - shading that is not actually flat, because a later stage re-introduced a
    gradient (the theme grade did exactly this and it was invisible in a
    thumbnail — only a tone COUNT catches it)
  - a face rendering with no features, which is the illustrated equivalent of
    the empty-silhouette bug the old line renderer shipped
  - features drawn somewhere other than where the landmarks say they are
  - small/dim captures losing detail to upscaling before processing
  - one guest looking great and the next looking broken, so the multi-face
    section runs the whole pipeline across every varied face available rather
    than proving it once on a flattering portrait
"""
import glob
import os
import sys
import time

sys.path.insert(0, ".")

import cv2
import numpy as np
from PIL import Image

from services.face_parse_service import (
    face_parse_service, LEFT_EYE, RIGHT_EYE, LIPS_OUTER,
)
from services.watercolor_service import (
    watercolor_preset, flatten_regions, draw_features, draw_outlines,
    _line_color, PRESETS, RENDER_HEIGHT, REGION_SPEC, MAX_COLOUR_PARTS,
    DEFAULT_PRESET,
)
from services.plexus_background import generate_plexus
from services.geometric_overlays import compose_duotone_artwork

_sess = None

TEST_IMAGE = "../templates/photobooth (1).jpg.jpeg"
OUT_DIR = "../outputs"

# A flat-shaded region contributes at most `levels` colours PER COLOUR MASS, so
# the ceiling is derived from the renderer's own tables rather than pinned to a
# number. A hardcoded ceiling has to be re-guessed every time a preset changes
# its level count, and the tempting fix at that point is to raise it until the
# suite goes green — which quietly turns the one check that proves the output is
# quantised at all into a check that proves nothing.
def max_tones(preset: str) -> int:
    ls = PRESETS[preset].get("levels_scale", 1.0)
    per_region = sum(max(2, round(spec["levels"] * ls)) for spec in REGION_SPEC.values())
    return per_region * MAX_COLOUR_PARTS


# A continuous-tone photograph of a face runs to five figures of distinct
# colours, so even the loosest derived ceiling is three orders of magnitude
# below "the quantiser stopped working".
MAX_TONES = max_tones(DEFAULT_PRESET)
# A portrait with real modelling varies across the subject; a flat blob is ~0.
MIN_TONAL_SPREAD = 15.0

failures: list[str] = []


def check(label: str, ok: bool, detail: str = "") -> None:
    print(f"   {'PASS' if ok else 'FAIL'}  {label}{(' — ' + detail) if detail else ''}")
    if not ok:
        failures.append(label)


def tone_count(art: Image.Image) -> int:
    """
    Unique flat tones in the SHADED INTERIOR of the subject.

    Two things in the render are continuous by design and must be excluded, or
    this measures them instead of the thing it claims to measure:

      - anti-aliased strokes, which contribute a long tail of one-off blend
        colours along every line (handled by the area threshold)
      - the rim light, a feathered neon gradient deliberately painted around the
        silhouette (handled by eroding the mask inward)

    Counting without the erosion reports ~100 tones on a render whose shading is
    genuinely 16 flat colours, which looks like a broken quantiser and is not.
    """
    rgb = np.array(art.convert("RGB"))
    a = np.array(art.getchannel("A"))
    solid = (a > 200).astype(np.uint8)
    if not solid.any():
        return 0
    rim = max(3, int(round(min(art.width, art.height) * 0.030)))
    interior = cv2.erode(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rim * 2 + 1,) * 2)) > 0
    if interior.sum() < 500:
        interior = solid > 0
    cols, counts = np.unique(rgb[interior].reshape(-1, 3), axis=0, return_counts=True)
    return int((counts > interior.sum() * 0.001).sum())


def tonal_spread(art: Image.Image) -> float:
    lum = np.array(art.convert("L"))
    a = np.array(art.getchannel("A"))
    subj = a > 140
    return float(lum[subj].std()) if subj.any() else 0.0


def cutout(img: Image.Image) -> Image.Image:
    """Local background removal, so the suite needs no network or FAL key."""
    from rembg import new_session, remove
    global _sess
    if _sess is None:
        _sess = new_session("isnet-general-use")
    return remove(img, session=_sess).convert("RGBA")


print("=" * 70)
print("WATERCOLOR / ILLUSTRATED PORTRAIT PIPELINE — SMOKE TEST")
print("=" * 70)

print(f"\n1. Face parsing service")
check("service available", face_parse_service.available)
src = Image.open(TEST_IMAGE).convert("RGB")
# Downscale only. Enlarging a capture is exactly what the renderer refuses to do,
# so a test that feeds it an upscaled source is not testing the real path.
if max(src.size) > 1600:
    f = 1600 / max(src.size)
    src = src.resize((int(src.width * f), int(src.height * f)), Image.LANCZOS)
cut = cutout(src)

parse = face_parse_service.parse(cut)
check("parse returns a result", parse is not None)
if parse is not None:
    cov = parse.coverage()
    check("landmarks found", parse.landmarks is not None,
          f"{0 if parse.landmarks is None else len(parse.landmarks)} points")
    check("478-point topology (includes iris)",
          parse.landmarks is not None and len(parse.landmarks) == 478)
    check("person occupies a sane share of canvas",
          5.0 < (100 - cov["background"]) < 95.0,
          f"{100 - cov['background']:.1f}% non-background")
    check("skin and hair both found",
          cov["face_skin"] > 0.5 and (cov["hair"] > 0.1 or cov["body_skin"] > 0.5),
          f"face={cov['face_skin']:.1f}% hair={cov['hair']:.1f}% body={cov['body_skin']:.1f}%")

print("\n2. Every preset yields FLAT shading with real modelling")
for name in PRESETS:
    t0 = time.perf_counter()
    art = watercolor_preset(cut, preset=name, landmarks=None, auto_crop=False)
    ms = (time.perf_counter() - t0) * 1000
    tones, spread = tone_count(art), tonal_spread(art)
    ceiling = max_tones(name)
    check(f"preset '{name}' is flat", 2 <= tones <= ceiling,
          f"{tones} tones (2..{ceiling} expected)")
    check(f"preset '{name}' keeps modelling", spread >= MIN_TONAL_SPREAD,
          f"spread={spread:.1f} (>= {MIN_TONAL_SPREAD}), {ms:.0f}ms")

print("\n3. Facial features are drawn AT the landmark positions")
# The real risk is not that drawing raises, but that it lands somewhere wrong —
# an iris painted off the eye is worse than no iris. So compare the rendered
# result against the source inside each feature polygon and require it changed.
# Verified against the landmarks from the SOURCE, which is what the renderer
# itself drew from. Re-parsing the finished artwork would be testing whether the
# landmarker can read an illustration — a different question, and one whose
# answer does not matter to the booth.
art = watercolor_preset(cut, landmarks=None, auto_crop=False)
p2 = parse
base = np.array(cut.convert("RGB").resize(art.size, Image.LANCZOS)).astype(np.int16)
rendered = np.array(art.convert("RGB")).astype(np.int16)
if p2 is not None and p2.landmarks is not None:
    sx, sy = art.width / max(p2.width, 1), art.height / max(p2.height, 1)
    p2.landmarks[:, 0] *= sx
    p2.landmarks[:, 1] *= sy
    for label, ids in (("left eye", LEFT_EYE), ("right eye", RIGHT_EYE), ("lips", LIPS_OUTER)):
        poly = p2.points(ids)
        m = np.zeros(rendered.shape[:2], np.uint8)
        cv2.fillPoly(m, [poly], 255)
        area = m > 0
        delta = float(np.abs(rendered[area] - base[area]).mean()) if area.any() else 0.0
        check(f"{label} redrawn", delta > 8.0, f"mean change {delta:.1f} inside the polygon")

    # The eye must show sclera rather than rendering as a dark blob.
    #
    # Measured as the SHARE of eye pixels brighter than the surrounding skin, not
    # as the region's mean. The mean is the wrong statistic: a correctly drawn
    # eye is mostly iris, pupil and lid line, so its average sits BELOW skin even
    # on renders that look right (measured: mean 75 vs skin 92 on a 69px eye that
    # reads perfectly). Asserting on the mean fails good output and would have
    # sent someone chasing a bug that was not there.
    eye = p2.points(RIGHT_EYE)
    m = np.zeros(rendered.shape[:2], np.uint8)
    cv2.fillPoly(m, [eye], 255)
    ring = cv2.dilate(m, np.ones((21, 21), np.uint8)) & ~m
    if (m > 0).any() and (ring > 0).any():
        lum = np.array(art.convert("L")).astype(np.float32)
        skin = float(lum[ring > 0].mean())
        eye_px = lum[m > 0]
        bright = float((eye_px > skin).mean() * 100)
        peak = float(np.percentile(eye_px, 90))
        check("sclera is visible (eye is not a dark blob)", bright >= 10.0,
              f"{bright:.0f}% of the eye brighter than skin (>= 10% expected)")
        check("sclera is genuinely bright", peak > skin + 20,
              f"eye p90={peak:.0f} vs skin={skin:.0f}")
else:
    check("features verifiable", False, "no landmarks on the rendered art")

print("\n4. Outlines are actually inked")
flat, painted, _bands = flatten_regions(np.array(cut.convert("RGB")), parse,
                                np.array(cut.getchannel("A")))
before = flat.copy()
stats = draw_outlines(flat, painted, np.array(cut.getchannel("A")), _line_color("orange"))
changed = int((np.abs(flat.astype(np.int16) - before.astype(np.int16)).max(axis=2) > 20).sum())
check("silhouette traced", stats["silhouette"] >= 1, f"{stats['silhouette']} contour(s)")
check("internal borders traced", stats["internal"] >= 1, f"{stats['internal']} contour(s)")
check("ink covers a plausible area", 0.001 < changed / flat[:, :, 0].size < 0.20,
      f"{changed / flat[:, :, 0].size * 100:.2f}% of canvas")

print("\n5. Themes change hue without changing structure")
shapes = {}
for theme in ("orange", "blue"):
    a = watercolor_preset(cut, theme=theme, landmarks=None, auto_crop=False)
    arr = np.array(a.convert("RGB"))
    hsv = cv2.cvtColor(arr, cv2.COLOR_RGB2HSV)
    alpha = np.array(a.getchannel("A")) > 140
    shapes[theme] = (np.array(a.convert("L")), alpha, float(np.median(hsv[:, :, 0][alpha])) * 2)
    check(f"theme '{theme}' stays flat", tone_count(a) <= MAX_TONES, f"{tone_count(a)} tones")
# Structure = where the tones sit; it must not move when only the palette does.
lum_o, m_o, hue_o = shapes["orange"]
lum_b, m_b, hue_b = shapes["blue"]
check("same subject coverage across themes",
      abs(int(m_o.sum()) - int(m_b.sum())) < m_o.size * 0.01,
      f"{int(m_o.sum())} vs {int(m_b.sum())} px")

print("\n6. Unknown preset / theme fall back instead of raising")
try:
    bad = watercolor_preset(cut, preset="nope", theme="chartreuse", landmarks=None, auto_crop=False)
    check("unknown names handled", bad.mode == "RGBA")
except Exception as e:
    check("unknown names handled", False, str(e))

print("\n7. Degraded inputs still produce something printable")
small = cut.resize((480, 600), Image.LANCZOS)
tiny_art = watercolor_preset(small, landmarks=None, auto_crop=False, render_height=RENDER_HEIGHT)
# Renders AT the canvas size even from a small capture. This inverts the rule the
# cartoon renderer follows, deliberately. That one refuses to upscale because it
# finds edges with a gradient operator, and enlarging first interpolates away the
# detail those edges come from. This renderer takes edges from the semantic parse
# and draws outlines and features as vector strokes, so the failure runs the other
# way: rendering a 576x720 booth capture at capture size and letting the
# compositor enlarge it to 1080x1350 draws every line and every eye at 576 and
# then blows them up 1.9x into mush.
check("renders at canvas size, not capture size", tiny_art.height == RENDER_HEIGHT,
      f"asked for {RENDER_HEIGHT}, rendered {tiny_art.width}x{tiny_art.height}")

dim = np.array(cut).astype(np.float32)
dim[:, :, :3] = dim[:, :, :3] * 0.5 + 30
dim_img = Image.fromarray(np.clip(dim, 0, 255).astype(np.uint8), "RGBA")
dim_art = watercolor_preset(dim_img, landmarks=None, auto_crop=False)
check("dim capture keeps modelling", tonal_spread(dim_art) >= MIN_TONAL_SPREAD,
      f"spread={tonal_spread(dim_art):.1f}")

# No parse at all — the path taken when MediaPipe is unavailable or the guest's
# face is not found. Must still render, just without features.
raw = np.array(cut.convert("RGB"))
alpha = np.array(cut.getchannel("A"))
noparse, painted_np, _b2 = flatten_regions(raw, None, alpha)
check("renders with no parse at all", noparse.shape == raw.shape and len(painted_np) >= 1,
      f"{len(painted_np)} region(s)")
d = draw_features(noparse, raw, None, (0, 0, 0))
check("feature drawing no-ops without landmarks", sum(d.values()) == 0)

try:
    blank = Image.new("RGBA", (400, 500), (0, 0, 0, 0))
    check("fully transparent input handled",
          watercolor_preset(blank, landmarks=None, auto_crop=False).mode == "RGBA")
except Exception as e:
    check("fully transparent input handled", False, str(e))

print("\n8. Plexus background is deterministic and themed")
a1 = generate_plexus(540, 540, "orange")
a2 = generate_plexus(540, 540, "orange")
b1 = generate_plexus(540, 540, "blue")
check("same inputs give identical background", np.array_equal(a1, a2))
check("theme changes the background", not np.array_equal(a1, b1))
check("background is not flat", float(a1.reshape(-1, 3).std(axis=0).mean()) > 2.0,
      f"std={float(a1.reshape(-1, 3).std(axis=0).mean()):.1f}")

print("\n9. Frame matte still clips watercolor to the triangle")
FRAMES = {
    "cartoon-frame-square.png": (1080, 1080),
    "cartoon-frame-portrait.png": (1080, 1350),
    "cartoon-frame-square-blue.png": (1080, 1080),
}
for fname, (fw, fh) in FRAMES.items():
    fpath = f"../templates/{fname}"
    if not os.path.exists(fpath):
        check(f"{fname} exists", False, "missing")
        continue
    window = np.array(Image.open(fpath).convert("RGBA").getchannel("A")) < 128
    loud = Image.new("RGBA", (fw, fh), (255, 0, 255, 255))
    out = np.array(compose_duotone_artwork(
        loud, canvas_width=fw, canvas_height=fh,
        backdrop_image=Image.fromarray(generate_plexus(fw, fh, "orange")),
        frame_path=os.path.abspath(fpath), fit="frame",
    ))
    leaked = (out[:, :, 0] > 200) & (out[:, :, 1] < 80) & (out[:, :, 2] > 200)
    check(f"{fname} leaks nothing outside the window", int((leaked & ~window).sum()) == 0,
          f"{int((leaked & ~window).sum())} stray px")
    check(f"{fname} shows the subject inside", leaked[window].mean() > 0.8,
          f"{leaked[window].mean() * 100:.0f}% filled")

print("\n10. Transparent output keeps alpha where an animation shows through")
# The artwork modes exist to be layered over video, so the triangle interior the
# subject does not cover must be genuinely clear. Two separate things can quietly
# destroy this: the compositor flattening to RGB, and the storage layer pasting
# RGBA onto white before encoding JPEG. Both did, at one point.
fpath = "../templates/cartoon-frame-square.png"
if os.path.exists(fpath):
    subj = watercolor_preset(cut, landmarks=None, auto_crop=False, render_height=1080)
    clear = compose_duotone_artwork(
        subj, canvas_width=1080, canvas_height=1080,
        frame_path=os.path.abspath(fpath), fit="frame", transparent=True,
    )
    check("transparent compose returns RGBA", clear.mode == "RGBA", f"mode={clear.mode}")

    a = np.array(clear.getchannel("A"))
    window = np.array(Image.open(fpath).convert("RGBA").getchannel("A")) < 128
    inside_clear = float((a[window] == 0).mean() * 100)
    outside_opaque = float((a[~window] > 200).mean() * 100)
    check("triangle interior has clear pixels", inside_clear > 0.5,
          f"{inside_clear:.1f}% of the window fully transparent")
    check("frame art outside stays opaque", outside_opaque > 95.0,
          f"{outside_opaque:.1f}% opaque")

    # Opaque compose must NOT gain alpha — every other mode depends on RGB.
    solid = compose_duotone_artwork(
        subj, canvas_width=1080, canvas_height=1080,
        frame_path=os.path.abspath(fpath), fit="frame",
    )
    check("opaque compose still returns RGB", solid.mode == "RGB", f"mode={solid.mode}")
else:
    check("frame available for transparency test", False, "missing")

print("\n11. Consistency across varied real faces")
# The single biggest risk for an event is not one bad render but a mode that
# flatters some guests and mangles others, so this runs the full pipeline over
# every varied face available rather than proving the happy path once.
CANDIDATES = sorted(glob.glob("../../../Users/studi/Downloads/*.jpe*g")
                    + glob.glob("C:/Users/studi/Downloads/*.jpeg")
                    + glob.glob("C:/Users/studi/Downloads/*.jpg"))
faces, seen = [], set()
for f in CANDIDATES:
    b = os.path.basename(f)
    if b in seen:
        continue
    seen.add(b)
    faces.append(f)
faces = faces[:40]

tested = 0
bad: list[str] = []
for f in faces:
    try:
        im = Image.open(f).convert("RGB")
    except Exception:
        continue
    if min(im.size) < 300:
        continue
    if im.height > 900:
        im = im.resize((int(im.width * 900 / im.height), 900), Image.LANCZOS)
    pr = face_parse_service.parse(im)
    if pr is None or pr.landmarks is None:
        continue          # not a usable portrait; not a failure of the renderer
    c = cutout(im)
    a = watercolor_preset(c, landmarks=None, auto_crop=False)
    tested += 1
    t, s = tone_count(a), tonal_spread(a)
    if not (2 <= t <= MAX_TONES):
        bad.append(f"{os.path.basename(f)}: {t} tones")
    elif s < MIN_TONAL_SPREAD:
        bad.append(f"{os.path.basename(f)}: spread {s:.1f}")
    if tested >= 8:
        break

if tested == 0:
    print("   SKIP  no varied portraits available on this machine")
else:
    check(f"all {tested} varied faces render flat with modelling", not bad,
          "; ".join(bad) if bad else f"{tested} faces, every one within bounds")

print("\n12. Un-inked default: no line art, punchier colour")
# The default preset renders as a graded photograph rather than a drawing, so
# the properties that matter are the absence of ink and the presence of colour
# separation — neither of which the flatness checks above can see.
from services.watercolor_service import _colour_split, _build_region_ramp
from services.face_parse_service import FACE_SKIN

no_ink = draw_outlines(np.zeros((600, 600, 3), np.uint8), {}, np.full((600, 600), 255, np.uint8),
                       (20, 20, 20), line_scale=0.0)
check("line_scale 0 draws nothing", sum(no_ink.values()) == 0, f"{no_ink}")

# A stroke is a THIN dark structure laid over shading, so it is detected by
# thinness, not by darkness. Counting near-black pixels instead reports ~45% on
# both presets, because it is measuring the guest's dark hair and clothing —
# which is a property of the photograph, not of the renderer. Black-hat responds
# only to dark detail narrower than its kernel, which is exactly what a drawn
# line is and exactly what a shaded mass is not.
# "No line art" is asserted on the MECHANISM, not on a pixel statistic.
#
# The obvious pixel test — count thin dark strokes in the finished render — was
# tried and does not work here, in a way worth recording so it is not retried.
# At this level count a shading band can itself be two pixels wide, so black-hat
# thinness fires on ordinary flat shading; and on a dark-haired guest those
# bands also land within tolerance of the ink colour, so requiring both
# properties does not separate them either. The two presets come out 0.34% vs
# 0.64% — a gap far too narrow to distinguish "no ink" from "dark hair".
#
# The three checks below prove the same property structurally and exactly.
check(f"default '{DEFAULT_PRESET}' is configured with no ink",
      PRESETS[DEFAULT_PRESET]["line_scale"] == 0, f"line_scale={PRESETS[DEFAULT_PRESET]['line_scale']}")

# Re-parsed at the cutout's own size. The parse from section 1 cannot be reused:
# section 3 rescales its landmarks IN PLACE into artwork coordinates, so by this
# point that object no longer describes `cut`.
p_feat = face_parse_service.parse(cut)
if p_feat is None or p_feat.landmarks is None:
    # Reported, not skipped silently — a check that quietly vanishes reads as a
    # pass in the summary line, which is the failure mode this suite exists to
    # avoid.
    check("stroke switch is exercised", False, "re-parse found no landmarks")
else:
    src_px = np.array(cut.convert("RGB"))
    canvas_a = np.zeros_like(src_px)
    canvas_b = np.zeros_like(src_px)
    with_ink = draw_features(canvas_a, src_px, p_feat, (20, 18, 16), strokes=True)
    no_ink_f = draw_features(canvas_b, src_px, p_feat, (20, 18, 16), strokes=False)
    # Jaw and nose are stroke-ONLY features: they have no fill, so they are the
    # cleanest evidence that the stroke switch is honoured.
    check("strokes=False drops the jaw and nose lines",
          with_ink["jaw"] + with_ink["nose"] > 0
          and no_ink_f["jaw"] + no_ink_f["nose"] == 0,
          f"inked jaw/nose={with_ink['jaw']}/{with_ink['nose']}, "
          f"plain={no_ink_f['jaw']}/{no_ink_f['nose']}")
    # ...while the sampled colour work still runs, which is the whole point of
    # splitting the two: an un-inked face still gets its own eyes.
    check("strokes=False keeps the sampled eye and lip colour",
          no_ink_f["eyes"] == with_ink["eyes"] and no_ink_f["lips"] == with_ink["lips"],
          f"eyes={no_ink_f['eyes']} lips={no_ink_f['lips']}")

plain = watercolor_preset(cut, preset=DEFAULT_PRESET, landmarks=None, auto_crop=False)
inked = watercolor_preset(cut, preset="wc_natural", landmarks=None, auto_crop=False)

# Contrast and vividness must move the picture, not just the parameters.
def spread_and_sat(art: Image.Image) -> tuple[float, float]:
    a = np.array(art.getchannel("A")) > 200
    hsv = cv2.cvtColor(np.array(art.convert("RGB")), cv2.COLOR_RGB2HSV)
    lum = np.array(art.convert("L"))
    return float(lum[a].std()), float(hsv[..., 1][a].mean())

flat_sp, flat_sat = spread_and_sat(inked)
viv_sp, viv_sat = spread_and_sat(plain)
check("default is more saturated than the inked preset", viv_sat > flat_sat * 1.05,
      f"S {viv_sat:.1f} vs {flat_sat:.1f}")
check("default keeps tonal range", viv_sp >= MIN_TONAL_SPREAD, f"spread={viv_sp:.1f}")

# The ramp is where contrast and vividness are applied, so assert it there too:
# a curve over finished pixels would pass a whole-image check while silently
# undoing the quantisation.
spec = REGION_SPEC[FACE_SKIN]
base_ramp = _build_region_ramp((190, 150, 130), spec, "orange", 0.0, levels=8)
hot_ramp = _build_region_ramp((190, 150, 130), spec, "orange", 0.0, levels=8,
                              contrast=1.35, vividness=1.28)
b_rng = int(base_ramp.max(axis=0).mean() - base_ramp.min(axis=0).mean())
h_rng = int(hot_ramp.max(axis=0).mean() - hot_ramp.min(axis=0).mean())
check("contrast widens the ramp", h_rng > b_rng, f"range {h_rng} vs {b_rng}")
check("level count is honoured exactly", len(hot_ramp) == 8, f"{len(hot_ramp)} steps")

# A greyscale photograph must render greyscale. The skin saturation floor exists
# to rescue a badly white-balanced colour capture; fired on a genuinely
# monochrome source it invents a complexion, and vividness then pushes that
# invention to a strong pink.
grey_ramp = _build_region_ramp((150, 150, 150), spec, "orange", 0.0, levels=8,
                               contrast=1.22, vividness=1.26, monochrome=True)
grey_chroma = float((grey_ramp.max(axis=1).astype(int) - grey_ramp.min(axis=1).astype(int)).mean())
colour_ramp = _build_region_ramp((150, 150, 150), spec, "orange", 0.0, levels=8,
                                 contrast=1.22, vividness=1.26)
col_chroma = float((colour_ramp.max(axis=1).astype(int) - colour_ramp.min(axis=1).astype(int)).mean())
check("grey source stays grey", grey_chroma < 4.0, f"chroma {grey_chroma:.1f}")
check("colour source still gets the saturation floor", col_chroma > 20.0,
      f"chroma {col_chroma:.1f} (floor must still rescue washed-out captures)")

# And end to end, because the detection lives in flatten_regions, not the ramp.
mono_src = Image.open(TEST_IMAGE).convert("L").convert("RGB")
if max(mono_src.size) > 1000:
    f = 1000 / max(mono_src.size)
    mono_src = mono_src.resize((int(mono_src.width * f), int(mono_src.height * f)), Image.LANCZOS)
mono_art = watercolor_preset(cutout(mono_src), landmarks=None, auto_crop=False)
ma = np.array(mono_art.convert("RGB")).astype(np.int16)
msel = np.array(mono_art.getchannel("A")) > 200
# The rim light is a deliberate neon edge and is genuinely coloured, so measure
# the interior the same way the tone count does.
rim_px = max(3, int(round(min(mono_art.size) * 0.030)))
inner = cv2.erode(msel.astype(np.uint8),
                  cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (rim_px * 2 + 1,) * 2)) > 0
if inner.sum() > 500:
    mono_chroma = float((ma[inner].max(axis=1) - ma[inner].min(axis=1)).mean())
    check("greyscale photo renders without invented colour", mono_chroma < 12.0,
          f"mean chroma {mono_chroma:.1f}")

# Colour splitting: two distinct masses must separate, one shaded mass must not.
lab = cv2.cvtColor(np.zeros((200, 200, 3), np.uint8), cv2.COLOR_RGB2LAB).astype(np.float32)
two = np.zeros((200, 200, 3), np.uint8)
two[:, :100] = (230, 220, 200)      # cream shirt
two[:, 100:] = (30, 70, 200)        # blue jersey
lab2 = cv2.cvtColor(two, cv2.COLOR_RGB2LAB).astype(np.float32)
parts2 = _colour_split(np.ones((200, 200), bool), lab2)
check("two garments split into separate ramps", len(parts2) >= 2, f"{len(parts2)} part(s)")

# One skin tone under a strong lighting gradient — the case that must NOT split,
# because that variation is shading and the ramp already handles it.
grad = np.zeros((200, 200, 3), np.uint8)
ramp_v = np.linspace(0.45, 1.0, 200, dtype=np.float32)[None, :, None]
grad[:] = (np.array((205, 165, 140), np.float32)[None, None, :] * ramp_v).astype(np.uint8)
labg = cv2.cvtColor(grad, cv2.COLOR_RGB2LAB).astype(np.float32)
parts1 = _colour_split(np.ones((200, 200), bool), labg)
check("shaded single tone stays one mass", len(parts1) == 1,
      f"{len(parts1)} part(s) — lightness must not drive the split")

# Determinism: the module's contract is that a guest always gets the same art.
check("colour split is deterministic",
      len(_colour_split(np.ones((200, 200), bool), lab2)) == len(parts2), "repeat run matches")

print("\n" + "=" * 70)
if failures:
    print(f"FAILED — {len(failures)} check(s): {', '.join(failures)}")
    sys.exit(1)
print("ALL CHECKS PASSED")
print("=" * 70)
