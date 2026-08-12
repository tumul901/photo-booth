"""
Watercolor Portrait Service
===========================
Renders a photograph as a flat-shaded illustrated portrait — the look used by the
"Watercolor" booth mode: discrete tonal bands per region, drawn outlines that
follow anatomy, and vector-drawn facial features, all sitting inside the existing
neon triangle frame.

Nothing here generates pixels. Every colour comes from the photograph and every
line is traced from a measured boundary, so the same guest always produces the
same artwork and no cloud round-trip is involved.

The design turns on two choices that between them fix the failure mode of the
earlier line-art attempt:

1. LINES COME FROM SEMANTIC BOUNDARIES, NOT IMAGE GRADIENTS.
   Gradient operators (XDoG, Canny) answer "is there a luminance step here?",
   which is a question about texture. They produce nothing along a jawline lit
   evenly against a neck and a hundred spurious strokes across a patterned shirt.
   Region boundaries answer "does hair stop and skin start here?", which is the
   question an illustrator is actually answering when they draw that line.

2. COLOUR IS SAMPLED PER REGION, NOT IMPOSED FROM A PALETTE.
   Each region's ramp is built from that region's own median colour in the photo.
   Skin tone, hair colour and shirt colour therefore survive stylisation for
   every guest automatically, rather than every face being pushed toward one
   hard-coded complexion. A light theme grade is applied afterwards to tie the
   portrait to the neon frame it sits in.

Uses OpenCV, NumPy and Pillow. No AI image generation.
"""

import time
from typing import Optional

import colorsys
import cv2
import numpy as np
from PIL import Image, ImageFilter

from services.cartoon_service import get_theme, portrait_crop, DEFAULT_THEME
from services.face_parse_service import (
    face_parse_service, FaceParse,
    HAIR, BODY_SKIN, FACE_SKIN, CLOTHES, OTHERS,
)

RENDER_HEIGHT = 1350


# ── Per-region shading behaviour ─────────────────────────────────────────────
# `levels` is how many flat tones that region is reduced to. Skin carries the
# read of the whole portrait so it gets the most; hair and clothing read as
# masses and go flatter, which is what stops the result looking like a posterise
# filter applied uniformly to a photograph.
#
# `val` / `sat` are multipliers on the region's own median colour, darkest step
# first. Saturation rises into shadow because that is how illustrators paint
# them — a shadow desaturated toward grey reads as dirt, not depth.

#
# `v_range` / `s_range` clamp the sampled median before the ramp is built. This
# is what keeps the mode usable across real booth photos rather than only
# flattering ones. A guest in a dark suit under dim light samples to almost pure
# black, and scaling that by the ramp factors yields five indistinguishable
# blacks — a silhouette again. Clamping the anchor guarantees every region has
# somewhere to shade from. The skin floors do the same job for colour: booth
# white-balance routinely samples skin as near-grey, and a grey face reads as a
# corpse, so skin is held to a minimum warmth without being pushed to a fixed
# complexion.

REGION_SPEC: dict[int, dict] = {
    FACE_SKIN: {"levels": 4, "val": (0.52, 0.76, 1.00, 1.20), "sat": (1.22, 1.08, 1.00, 0.78),
                "v_range": (0.42, 0.88), "s_range": (0.24, 0.58)},
    BODY_SKIN: {"levels": 3, "val": (0.58, 0.85, 1.12),       "sat": (1.20, 1.05, 0.88),
                "v_range": (0.40, 0.88), "s_range": (0.22, 0.58)},
    HAIR:      {"levels": 3, "val": (0.45, 0.85, 1.45),       "sat": (1.10, 1.00, 0.80),
                "v_range": (0.16, 0.78), "s_range": (0.06, 0.62)},
    CLOTHES:   {"levels": 3, "val": (0.55, 0.90, 1.30),       "sat": (1.12, 1.00, 0.85),
                "v_range": (0.20, 0.88), "s_range": (0.00, 0.85)},
    OTHERS:    {"levels": 2, "val": (0.65, 1.15),             "sat": (1.10, 0.90),
                "v_range": (0.18, 0.85), "s_range": (0.00, 0.72)},
}

# Order matters: later regions paint over earlier ones where masks overlap after
# refinement. Skin last would erase a hairline, so hair goes on top of skin.
PAINT_ORDER = (CLOTHES, OTHERS, BODY_SKIN, FACE_SKIN, HAIR)


PRESETS: dict[str, dict] = {
    "wc_soft": {
        "presmooth": 2, "bilateral_sigma": 45.0, "clahe_clip": 0.8,
        "band_sigma": 0.065, "band_smooth": 0.9, "line_scale": 0.85,
        "grade": 0.10, "level_bias": 0.04, "rim": 0.42,
    },
    "wc_standard": {
        "presmooth": 2, "bilateral_sigma": 60.0, "clahe_clip": 1.0,
        "band_sigma": 0.050, "band_smooth": 1.0, "line_scale": 1.05,
        "grade": 0.14, "level_bias": 0.0, "rim": 0.55,
    },
    "wc_bold": {
        "presmooth": 3, "bilateral_sigma": 80.0, "clahe_clip": 1.4,
        "band_sigma": 0.038, "band_smooth": 1.25, "line_scale": 1.3,
        "grade": 0.18, "level_bias": -0.04, "rim": 0.68,
    },
}

DEFAULT_PRESET = "wc_standard"


# ── Colour helpers ───────────────────────────────────────────────────────────

def _clamp_rgb(rgb) -> tuple[int, int, int]:
    return tuple(int(np.clip(round(c), 0, 255)) for c in rgb)


def _build_region_ramp(base_rgb, spec: dict, theme: str, grade: float) -> np.ndarray:
    """
    Flat tones for one region, derived from its own median colour.

    Returns (levels, 3) uint8, darkest first. Working in HSV keeps the region's
    hue fixed while value and saturation move, so a navy shirt stays navy through
    its whole ramp instead of drifting toward black or grey.

    The theme grade is baked into the ramp HERE rather than applied to pixels
    afterwards. That ordering is not cosmetic: grading pixels by their luminance
    re-introduces a continuous gradient and silently undoes the quantisation,
    turning a 15-colour cel render back into a smudged photograph. Grading the
    ramp keeps the output at exactly `levels` colours per region.
    """
    r, g, b = [c / 255.0 for c in base_rgb]
    h, s, v = colorsys.rgb_to_hsv(r, g, b)
    v = float(np.clip(v, *spec["v_range"]))
    s = float(np.clip(s, *spec["s_range"]))

    palette = get_theme(theme)
    accent = np.array(palette["accent"], np.float32)
    shade = np.array(palette["backdrop"], np.float32)

    out = []
    for vf, sf in zip(spec["val"], spec["sat"]):
        rr, gg, bb = colorsys.hsv_to_rgb(h, min(s * sf, 1.0), min(v * vf, 1.0))
        col = np.array([rr * 255, gg * 255, bb * 255], np.float32)
        if grade > 0:
            # Light steps drift toward the neon accent, dark steps toward the
            # backdrop, so the figure reads as lit by the triangle it sits in.
            lum = float(col @ np.array([0.299, 0.587, 0.114], np.float32)) / 255.0
            target = shade + (accent - shade) * lum
            col = col + (target - col) * (grade * lum)
        out.append(_clamp_rgb(col))
    return np.array(out, np.uint8)


def _line_color(theme: str) -> tuple[int, int, int]:
    """
    Outline colour: a very dark, slightly desaturated version of the theme hue.

    Pure black outlines read as clip-art and fight the neon frame. Tinting the
    line toward the theme is what makes the drawing feel lit by the triangle it
    sits inside.
    """
    accent = get_theme(theme)["accent"]
    h, s, _ = colorsys.rgb_to_hsv(*[c / 255 for c in accent])
    r, g, b = colorsys.hsv_to_rgb(h, s * 0.55, 0.19)
    return _clamp_rgb((r * 255, g * 255, b * 255))


def _clean_bands(idx: np.ndarray, levels: int, mask: np.ndarray, min_area: int) -> np.ndarray:
    """
    Delete speckle from a quantised band map by area, not by blur.

    Quantisation turns any residual texture — fabric weave, stubble, JPEG
    blocking — into confetti: hundreds of few-pixel islands of the neighbouring
    tone. Median blurring shrinks them but leaves a grainy fizz that reads as
    dirt on a print. Removing whole connected components below an area floor and
    refilling from their surroundings deletes them outright, which is what makes
    the shading read as deliberate shapes an illustrator placed.
    """
    out = idx.copy()
    UNSET = 255
    for lv in range(levels):
        m = ((idx == lv) & mask).astype(np.uint8)
        if not m.any():
            continue
        n, lab, stats, _ = cv2.connectedComponentsWithStats(m, 8)
        for i in range(1, n):
            if stats[i, cv2.CC_STAT_AREA] < min_area:
                out[lab == i] = UNSET

    holes = (out == UNSET) & mask
    if holes.any():
        # Refill each deleted island with the dominant tone around it. A median
        # window wider than the island itself is majority-decided by the intact
        # surroundings, so this resolves to "whatever this speckle was sitting
        # in" without needing a nearest-neighbour search.
        k = int(np.clip(int(np.sqrt(min_area)) * 2 + 1, 5, 15)) | 1
        donor = out.copy()
        donor[holes] = 0
        med = cv2.medianBlur(donor, k)
        out[holes] = med[holes]
    return out


# ── Contour simplification ───────────────────────────────────────────────────

def _smooth_closed(pts: np.ndarray, iterations: int) -> np.ndarray:
    """
    Chaikin corner-cutting on a closed polygon — turns it into a smooth curve.

    Douglas-Peucker alone leaves a faceted outline that reads as pixel art at
    print size. Simplifying hard and then re-rounding is what produces a line
    that looks drawn: the simplify step removes pixel noise, the rounding step
    puts back curvature that follows the form rather than the noise.
    """
    p = np.asarray(pts, np.float32)
    for _ in range(max(iterations, 0)):
        if len(p) < 3:
            break
        nxt = np.roll(p, -1, axis=0)
        a = 0.75 * p + 0.25 * nxt
        b = 0.25 * p + 0.75 * nxt
        p = np.empty((len(p) * 2, 2), np.float32)
        p[0::2] = a
        p[1::2] = b
    return p


def _trace(
    canvas: np.ndarray,
    mask: np.ndarray,
    color: tuple[int, int, int],
    thickness: int,
    *,
    simplify: float = 0.0025,
    smooth: int = 2,
    min_area_frac: float = 0.0004,
) -> int:
    """
    Draw a region's boundary as smoothed, simplified strokes. Returns stroke count.

    Small blobs are dropped: a refined mask always has a few stray islands, and
    outlining them scatters unexplained dots across the face.
    """
    m = mask.astype(np.uint8)
    if not m.any():
        return 0
    # Close pinholes first — an unclosed 1px gap becomes a contour that doubles
    # back on itself and draws a visible spur.
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
    contours, _ = cv2.findContours(m, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    min_area = min_area_frac * mask.size
    drawn = 0
    for c in contours:
        if cv2.contourArea(c) < min_area:
            continue
        approx = cv2.approxPolyDP(c, simplify * cv2.arcLength(c, True), True)
        pts = approx.reshape(-1, 2).astype(np.float32)
        if len(pts) < 3:
            continue
        smoothed = _smooth_closed(pts, smooth)
        cv2.polylines(canvas, [np.round(smoothed).astype(np.int32)], True,
                      color, thickness, cv2.LINE_AA)
        drawn += 1
    return drawn


# ── Core render ──────────────────────────────────────────────────────────────

def flatten_regions(
    rgb: np.ndarray,
    parse: Optional[FaceParse],
    alpha: np.ndarray,
    *,
    theme: str = DEFAULT_THEME,
    grade: float = 0.14,
    presmooth: int = 2,
    bilateral_sigma: float = 60.0,
    clahe_clip: float = 1.0,
    band_sigma: float = 0.05,
    band_smooth: float = 1.0,
    level_bias: float = 0.0,
    work_max: int = 720,
) -> tuple[np.ndarray, dict[int, np.ndarray]]:
    """
    Reduce each semantic region to a few flat tones sampled from that region.

    Returns (flattened RGB, {class: boolean mask actually painted}).

    Without a parse everything inside the alpha is treated as one region. That
    still yields a cel-shaded portrait — just without the hair/skin/clothing
    separation — which is the right degradation for a guest whose face the
    landmarker could not find mid-event.
    """
    full_h, full_w = rgb.shape[:2]
    subject_full = alpha > 100

    # Band-finding runs at reduced resolution. A tonal band is a large shape by
    # definition — the smallest is a nose shadow, tens of pixels across — so the
    # per-level connected-component sweep and the domain-transform pass gain
    # nothing from full resolution while costing quadratically in it. Only the
    # final colour lookup happens at output size, so the ramp itself stays exact.
    scale = min(1.0, work_max / max(full_h, full_w))
    if scale < 1.0:
        w = max(int(round(full_w * scale)), 1)
        h = max(int(round(full_h * scale)), 1)
        rgb_w = cv2.resize(rgb, (w, h), interpolation=cv2.INTER_AREA)
        alpha_w = cv2.resize(alpha, (w, h), interpolation=cv2.INTER_AREA)
        labels_w = (cv2.resize(parse.labels, (w, h), interpolation=cv2.INTER_NEAREST)
                    if parse is not None else None)
    else:
        h, w = full_h, full_w
        rgb_w, alpha_w = rgb, alpha
        labels_w = parse.labels if parse is not None else None

    subject = alpha_w > 100

    # Edge-preserving smoothing: flatten texture (pores, stubble, fabric weave)
    # while keeping the boundaries the tones will be quantised against.
    sm = rgb_w
    for _ in range(max(presmooth, 0)):
        sm = cv2.bilateralFilter(sm, 9, bilateral_sigma, bilateral_sigma)

    gray = cv2.cvtColor(sm, cv2.COLOR_RGB2GRAY)
    if clahe_clip > 0:
        # Deliberately gentle. CLAHE equalises LOCAL contrast, so quantising its
        # output bands each little tile independently and the face comes out in
        # camouflage patches that track nothing anatomical. Dim flat captures are
        # already rescued by the per-region percentile normalisation below, which
        # does the same job globally; this is only here to keep some bite in a
        # capture that is genuinely low-contrast everywhere.
        gray = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(4, 4)).apply(gray)

    # Band the FORM, not the texture. Bilateral smoothing preserves fabric weave
    # and stubble because they are genuine edges — correct for colour sampling,
    # wrong here, since quantising them shatters every band into confetti. A wide
    # domain-transform pass keeps only the large-scale shading gradient that
    # defines the form: brow shadow, cheekbone, jaw, nose.
    try:
        gray = cv2.ximgproc.dtFilter(
            sm, gray,
            sigmaSpatial=max(h, w) * band_sigma,
            sigmaColor=34.0,
            mode=cv2.ximgproc.DTF_RF,
        )
    except Exception:
        r = int(max(3, round(min(h, w) * band_sigma * 1.4)) | 1)
        gray = cv2.bilateralFilter(gray, min(r, 15), 90, 90)

    out = np.zeros_like(rgb)
    painted: dict[int, np.ndarray] = {}

    if labels_w is not None:
        regions = [(c, (labels_w == c) & subject) for c in PAINT_ORDER]
    else:
        regions = [(FACE_SKIN, subject)]

    for cls, mask in regions:
        if mask.sum() < 64:
            continue
        spec = REGION_SPEC.get(cls, REGION_SPEC[OTHERS])
        levels = spec["levels"]

        base = np.median(sm[mask].reshape(-1, 3), axis=0)
        ramp = _build_region_ramp(base, spec, theme, grade)

        # Robust normalisation inside the region. Percentiles rather than
        # min/max: one specular highlight on a forehead would otherwise
        # compress every real tone into the bottom band.
        vals = gray[mask].astype(np.float32)
        lo, hi = np.percentile(vals, (4, 96))
        if hi - lo < 1e-3:
            hi = lo + 1.0
        t = np.clip((gray.astype(np.float32) - lo) / (hi - lo) + level_bias, 0.0, 1.0)

        idx = np.clip((t * levels).astype(np.int32), 0, levels - 1).astype(np.uint8)

        # Clean the band map, not the image: a median pass on the level indices
        # removes the speckle that quantisation always produces along a soft
        # gradient, and leaves the band boundaries as clean shapes.
        k = int(max(3, round(min(h, w) * 0.006 * band_smooth)) | 1)
        idx = cv2.medianBlur(idx, min(k, 31))
        idx = _clean_bands(idx, levels, mask,
                           min_area=int(max(24, mask.size * 0.00025 * band_smooth)))

        # Back to output resolution for the colour lookup. NEAREST on the band
        # indices, never on the colours: interpolating between two ramp steps
        # would manufacture in-between tones and undo the quantisation at every
        # band edge — the same trap as grading pixels instead of the ramp.
        if scale < 1.0:
            idx_full = cv2.resize(idx, (full_w, full_h), interpolation=cv2.INTER_NEAREST)
            mask_full = cv2.resize(mask.astype(np.uint8), (full_w, full_h),
                                   interpolation=cv2.INTER_NEAREST).astype(bool) & subject_full
        else:
            idx_full, mask_full = idx, mask

        out[mask_full] = ramp[np.clip(idx_full[mask_full], 0, levels - 1)]
        painted[cls] = mask_full

    return out, painted


def draw_outlines(
    canvas: np.ndarray,
    painted: dict[int, np.ndarray],
    alpha: np.ndarray,
    color: tuple[int, int, int],
    *,
    line_scale: float = 1.0,
) -> dict[str, int]:
    """
    Ink the drawing: outer silhouette heavy, internal region borders lighter.

    The silhouette is traced from the rembg alpha rather than from the parse.
    BiRefNet resolves hair wisps and finger gaps that a 256px segmenter cannot,
    and the silhouette is the one line a viewer reads first.
    """
    h, w = canvas.shape[:2]
    unit = max(h, w) / 1000.0
    outer_t = max(2, int(round(4.2 * unit * line_scale)))
    inner_t = max(1, int(round(2.6 * unit * line_scale)))

    stats = {"silhouette": 0, "internal": 0}
    stats["silhouette"] = _trace(canvas, alpha > 128, color, outer_t,
                                 simplify=0.0016, smooth=3, min_area_frac=0.002)

    # Internal borders. Face and body skin are traced as ONE unioned region, not
    # separately: the parse puts a border across the jaw where face-skin meets
    # neck-skin, and inking it draws a line no illustrator would — it reads as a
    # decapitation. Unioning them keeps the outline an illustrator does draw
    # (skin against hair, collar and background) and drops the one they don't.
    skin = None
    for cls in (FACE_SKIN, BODY_SKIN):
        m = painted.get(cls)
        if m is not None:
            skin = m if skin is None else (skin | m)

    for m in (painted.get(HAIR), painted.get(CLOTHES), painted.get(OTHERS), skin):
        if m is None or m.sum() < 256:
            continue
        stats["internal"] += _trace(canvas, m, color, inner_t,
                                    simplify=0.0030, smooth=2, min_area_frac=0.0006)
    return stats


def add_rim_light(
    canvas: np.ndarray,
    alpha: np.ndarray,
    theme: str,
    *,
    strength: float = 0.55,
    width_frac: float = 0.014,
    direction: float = 1.0,
) -> None:
    """
    Paint a neon edge light along the subject's contour, in place.

    The portrait is composited into a glowing triangle, and without this it sits
    in front of the frame rather than inside it — the give-away is a figure whose
    every edge is darker than the light supposedly behind it. A rim in the frame's
    own colour is the cheapest cue that puts the subject in the scene.

    `direction` biases the rim to one side (1.0 = lit from the right). A rim of
    even strength all the way round reads as a sticker outline, because real edge
    light has a source.
    """
    h, w = canvas.shape[:2]
    band_px = max(2, int(round(min(h, w) * width_frac)))
    solid = (alpha > 128).astype(np.uint8)
    if not solid.any():
        return

    inner = cv2.erode(solid, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (band_px * 2 + 1,) * 2))
    band = cv2.GaussianBlur(((solid - inner) * 255).astype(np.uint8), (0, 0), band_px * 0.55)
    weight = band.astype(np.float32) / 255.0

    # Directional falloff across the canvas
    ramp = np.linspace(0.0, 1.0, w, dtype=np.float32)[None, :]
    if direction < 0:
        ramp = 1.0 - ramp
    weight *= (0.30 + 0.70 * ramp)

    neon = np.array(get_theme(theme)["triangle"], np.float32)
    a = np.clip(weight * strength, 0.0, 1.0)[..., None]
    np.copyto(canvas, np.clip(canvas.astype(np.float32) * (1 - a) + neon * a, 0, 255).astype(np.uint8))


def _sample(rgb: np.ndarray, poly: np.ndarray, fallback) -> np.ndarray:
    """Median colour inside a landmark polygon, for keeping real eye/lip colour."""
    m = np.zeros(rgb.shape[:2], np.uint8)
    cv2.fillPoly(m, [poly], 255)
    px = rgb[m > 0]
    if len(px) < 8:
        return np.array(fallback, np.float32)
    return np.median(px.reshape(-1, 3), axis=0).astype(np.float32)


def _shift(rgb, *, v: float = 1.0, s: float = 1.0) -> tuple[int, int, int]:
    """Scale a colour's HSV value/saturation, keeping its hue."""
    h, ss, vv = colorsys.rgb_to_hsv(*[float(c) / 255 for c in rgb])
    r, g, b = colorsys.hsv_to_rgb(h, min(ss * s, 1.0), min(vv * v, 1.0))
    return _clamp_rgb((r * 255, g * 255, b * 255))


def draw_features(
    canvas: np.ndarray,
    source_rgb: np.ndarray,
    parse: Optional[FaceParse],
    line_color: tuple[int, int, int],
    *,
    line_scale: float = 1.0,
) -> dict[str, int]:
    """
    Draw eyes, brows, lips and nose as vector shapes at measured positions.

    This is what separates an illustration from a photo filter. No amount of
    quantising and edge-finding recovers an eye from a booth capture: at typical
    framing an iris is twenty-odd pixels across and mostly motion blur, so
    filtering it yields a grey smudge. The landmarker, by contrast, reports
    exactly where the lid contour and the iris centre and radius ARE — so the
    renderer draws a clean eye there rather than trying to sharpen one out of
    mush.

    Nothing is invented: iris and lip colour are sampled from the guest's own
    pixels, so eye colour and lip tone stay theirs. Only the SHAPES are drawn.

    Returns a count of what was drawn, so tests can assert features actually
    landed rather than only that the call didn't raise.
    """
    from services.face_parse_service import (
        LEFT_EYE, RIGHT_EYE, LEFT_BROW, RIGHT_BROW, LIPS_OUTER, LIPS_INNER,
        LEFT_IRIS, RIGHT_IRIS, LEFT_IRIS_CENTER, RIGHT_IRIS_CENTER, NOSE_BASE,
        FACE_OVAL,
    )

    drawn = {"eyes": 0, "brows": 0, "lips": 0, "nose": 0, "teeth": 0, "jaw": 0}
    if parse is None or parse.landmarks is None:
        return drawn

    h, w = canvas.shape[:2]
    unit = max(h, w) / 1000.0
    lw = max(1, int(round(2.4 * unit * line_scale)))
    thin = max(1, int(round(1.6 * unit * line_scale)))

    oval = parse.points(FACE_OVAL)
    face_h = float(oval[:, 1].max() - oval[:, 1].min()) if oval is not None else h * 0.4

    # ── Eyes ──
    for eye_ids, iris_ids, iris_c in (
        (RIGHT_EYE, RIGHT_IRIS, RIGHT_IRIS_CENTER),
        (LEFT_EYE, LEFT_IRIS, LEFT_IRIS_CENTER),
    ):
        eye = parse.points(eye_ids)
        if eye is None or len(eye) < 6:
            continue
        eye_w = float(eye[:, 0].max() - eye[:, 0].min())
        if eye_w < 6:
            continue

        eye_mask = np.zeros((h, w), np.uint8)
        cv2.fillPoly(eye_mask, [eye], 255)

        # Sclera. Not pure white — a white eye on a flat-shaded face reads as a
        # cartoon decal, so it is tinted toward the surrounding skin.
        #
        # Sampled from a RING around the lid opening, not from inside it. Inside
        # is mostly iris, pupil and lashes, so sampling there yields a dark
        # anchor and the "white" of the eye comes out muddier than the face —
        # the eye then reads as a hole rather than an eye.
        ring = cv2.dilate(eye_mask, np.ones((max(3, int(eye_w * 0.5)),) * 2, np.uint8)) & ~eye_mask
        ring_px = source_rgb[ring > 0]
        skin_near = (np.median(ring_px.reshape(-1, 3), axis=0).astype(np.float32)
                     if len(ring_px) >= 8 else np.array((200, 175, 155), np.float32))
        sclera = _shift(skin_near, v=1.55, s=0.18)

        cv2.fillPoly(canvas, [eye], sclera, cv2.LINE_AA)

        # Iris: real centre and radius from the landmarker, real colour from the
        # photo. Drawn into a scratch layer and masked to the lid opening so a
        # wide-open iris cannot bleed past the eyelid.
        centre = parse.points([iris_c])[0]
        iris_pts = parse.points(iris_ids)
        if iris_pts is not None and len(iris_pts) >= 3:
            radius = float(np.mean(np.linalg.norm(iris_pts - centre, axis=1)))
        else:
            radius = eye_w * 0.22
        radius = float(np.clip(radius, eye_w * 0.14, eye_w * 0.42))

        iris_col = _sample(source_rgb, iris_pts if iris_pts is not None else eye, (70, 45, 30))
        layer = canvas.copy()
        cv2.circle(layer, tuple(centre), int(round(radius)), _shift(iris_col, v=0.85, s=1.35), -1, cv2.LINE_AA)
        cv2.circle(layer, tuple(centre), int(round(radius * 0.46)), _shift(iris_col, v=0.28, s=0.9), -1, cv2.LINE_AA)
        # Catchlight, offset up-left: the single cheapest thing that makes a
        # drawn eye look alive rather than dead.
        cv2.circle(layer, (int(centre[0] - radius * 0.34), int(centre[1] - radius * 0.36)),
                   max(1, int(round(radius * 0.24))), (250, 250, 252), -1, cv2.LINE_AA)
        canvas[eye_mask > 0] = layer[eye_mask > 0]

        # Lid: heavier along the top, as a drawn eye always is.
        cv2.polylines(canvas, [eye], True, line_color, thin, cv2.LINE_AA)
        top = eye[eye[:, 1] <= np.median(eye[:, 1])]
        if len(top) >= 2:
            order = top[np.argsort(top[:, 0])]
            cv2.polylines(canvas, [order], False, line_color, lw, cv2.LINE_AA)
        drawn["eyes"] += 1

    # ── Brows ──
    for brow_ids in (RIGHT_BROW, LEFT_BROW):
        brow = parse.points(brow_ids)
        if brow is None or len(brow) < 4:
            continue
        brow_col = _shift(_sample(source_rgb, brow, (60, 40, 30)), v=0.72, s=1.1)
        cv2.fillPoly(canvas, [brow], brow_col, cv2.LINE_AA)
        drawn["brows"] += 1

    # ── Lips ──
    outer = parse.points(LIPS_OUTER)
    inner = parse.points(LIPS_INNER)
    if outer is not None and len(outer) >= 6:
        # Only a light saturation lift. Pushing lips hard toward red paints
        # lipstick onto every guest, and the outer lip polygon overlaps moustache
        # on a lot of faces, so an aggressive tint stains facial hair pink.
        lip_col = _shift(_sample(source_rgb, outer, (150, 90, 85)), v=0.97, s=1.10)
        cv2.fillPoly(canvas, [outer], lip_col, cv2.LINE_AA)
        cv2.polylines(canvas, [outer], True, line_color, thin, cv2.LINE_AA)
        drawn["lips"] += 1

        if inner is not None and len(inner) >= 6:
            gap = float(inner[:, 1].max() - inner[:, 1].min())
            # Only draw a mouth interior when the landmarks say it is genuinely
            # open. Drawing teeth into a closed mouth is the classic uncanny
            # failure of automated avatars.
            if gap > face_h * 0.035:
                cv2.fillPoly(canvas, [inner], _shift(lip_col, v=0.30, s=0.8), cv2.LINE_AA)
                m = np.zeros((h, w), np.uint8)
                cv2.fillPoly(m, [inner], 255)
                ys, xs = np.nonzero(m)
                if len(ys):
                    # Upper half of the opening reads as the top row of teeth.
                    cut = ys.min() + (ys.max() - ys.min()) * 0.52
                    teeth = m.copy()
                    teeth[int(cut):, :] = 0
                    canvas[teeth > 0] = _shift(lip_col, v=2.4, s=0.10)
                    drawn["teeth"] = 1
                cv2.polylines(canvas, [inner], True, line_color, thin, cv2.LINE_AA)

    # ── Jaw ──
    # Only the lower arc of the face oval. The upper arc runs under the hairline
    # where an illustrator draws nothing — inking the full oval puts a headband
    # across the forehead. Sorting by x is safe here because a jaw runs
    # monotonically ear -> chin -> ear on any roughly frontal face.
    if oval is not None and len(oval) >= 8:
        cy = float(oval[:, 1].mean())
        lower = oval[oval[:, 1] > cy]
        if len(lower) >= 4:
            cv2.polylines(canvas, [lower[np.argsort(lower[:, 0])]], False,
                          line_color, lw, cv2.LINE_AA)
            drawn["jaw"] = 1

    # ── Nose base ──
    nose = parse.points(NOSE_BASE)
    if nose is not None and len(nose) >= 3:
        order = nose[np.argsort(nose[:, 0])]
        cv2.polylines(canvas, [order], False, line_color, thin, cv2.LINE_AA)
        drawn["nose"] = 1

    return drawn


def watercolor_preset(
    img: Image.Image,
    preset: str = DEFAULT_PRESET,
    theme: str = DEFAULT_THEME,
    landmarks=None,
    *,
    auto_crop: bool = True,
    render_height: int = RENDER_HEIGHT,
    parse: Optional[FaceParse] = None,
) -> Image.Image:
    """
    Full render: optional portrait crop → normalise size → parse → flatten → ink.

    Args:
        img:           RGBA subject cutout, post background removal.
        preset:        One of PRESETS.
        theme:         Theme name, shared with the cartoon/duotone mode.
        landmarks:     FaceLandmarks used only for the fallback crop.
        auto_crop:     Re-frame around the face. False when the guest already
                       framed themselves against the live capture guide.
        render_height: Target height. Never upscales — enlarging a small capture
                       interpolates detail away, and the outline tracer would
                       then follow interpolation artefacts.
        parse:         Pre-computed FaceParse, if the caller already has one.

    Returns:
        RGBA illustrated portrait, alpha carried through from the cutout.
    """
    t0 = time.perf_counter()
    params = dict(PRESETS.get(preset, PRESETS[DEFAULT_PRESET]))
    grade = params.pop("grade")
    line_scale = params.pop("line_scale")
    rim = params.pop("rim")

    cropped = portrait_crop(img, landmarks) if auto_crop else img
    if cropped.mode != "RGBA":
        cropped = cropped.convert("RGBA")

    effective_h = min(render_height, cropped.height) if cropped.height > 0 else render_height
    if effective_h != cropped.height and cropped.height > 0:
        target_w = max(int(effective_h * cropped.width / max(cropped.height, 1)), 1)
        scaled = cropped.resize((target_w, effective_h), Image.LANCZOS)
    else:
        scaled = cropped

    rgb = np.array(scaled.convert("RGB"))
    alpha = np.array(scaled.getchannel("A"))

    t_parse = time.perf_counter()
    if parse is None:
        parse = face_parse_service.parse(scaled)
    parse_ms = (time.perf_counter() - t_parse) * 1000

    t_flat = time.perf_counter()
    flat, painted = flatten_regions(rgb, parse, alpha, theme=theme, grade=grade, **params)
    flat_ms = (time.perf_counter() - t_flat) * 1000

    subject = alpha > 100
    # Count tones BEFORE inking. Strokes are drawn anti-aliased, so every one of
    # them contributes a few hundred blend colours along its length; counting
    # afterwards measures the line renderer, not the flatness of the shading.
    tones = int(len(np.unique(flat[subject].reshape(-1, 3), axis=0))) if subject.any() else 0

    t_ink = time.perf_counter()
    ink = _line_color(theme)
    stats = draw_outlines(flat, painted, alpha, ink, line_scale=line_scale)
    # Features last so lids and lips sit on top of the region outlines rather
    # than being crossed by them.
    feats = draw_features(flat, rgb, parse, ink, line_scale=line_scale)
    add_rim_light(flat, alpha, theme, strength=rim)
    ink_ms = (time.perf_counter() - t_ink) * 1000

    out = Image.fromarray(np.dstack([flat, alpha]).astype(np.uint8), "RGBA")
    out.putalpha(out.getchannel("A").filter(ImageFilter.GaussianBlur(0.6)))

    lum = np.array(out.convert("L"))
    spread = float(lum[subject].std()) if subject.any() else 0.0

    print(
        f"WATERCOLOR preset={preset} theme={theme} "
        f"parse={parse_ms:.0f}ms flatten={flat_ms:.0f}ms ink={ink_ms:.0f}ms "
        f"total={(time.perf_counter() - t0) * 1000:.0f}ms "
        f"in={img.width}x{img.height} render={out.width}x{out.height} "
        f"regions={len(painted)} tones={tones} "
        f"strokes={stats['silhouette']}+{stats['internal']} "
        f"features=eyes:{feats['eyes']},brows:{feats['brows']},lips:{feats['lips']},"
        f"teeth:{feats['teeth']},nose:{feats['nose']} "
        f"tonal_spread={spread:.1f} "
        f"parse={'yes' if parse is not None else 'NONE (degraded)'} "
        f"framing={'face-crop' if auto_crop else 'guest-framed'}",
        flush=True,
    )
    return out
