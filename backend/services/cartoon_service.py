"""
Duotone Portrait Service
========================
Renders a portrait as a tinted monochrome ("duotone") image — the look used by the
"Cartoon Artwork" booth mode: a tonal portrait mapped onto a single accent hue,
sitting inside a large neon triangle on a near-black backdrop.

Unlike a line renderer, this keeps the photograph's full tonal detail. Luminance
is mapped through a three-stop colour ramp:

    shadow  ->  accent  ->  highlight

Shadows land at (or just above) the backdrop value, so the figure fades into the
background instead of being hard-cut against it — that soft falloff is what makes
the reference look like a lit portrait rather than a pasted cutout.

Local contrast (CLAHE) runs before the mapping. Booth lighting is frequently dim
and flat, and without it a face collapses into a single mid-tone with no
modelling. Uses OpenCV + NumPy + Pillow; no AI image generation.
"""

import time

import cv2
import numpy as np
from PIL import Image, ImageFilter

# ── Colour themes ────────────────────────────────────────────────────────────
# Each theme drives the whole artwork: the portrait ramp, the backdrop, and the
# neon triangle, so everything stays in one hue family.
#
#   backdrop  — canvas fill
#   shadow    — darkest portrait tone (kept near the backdrop for a soft falloff)
#   accent    — midtone, the hue the portrait reads as
#   highlight — brightest portrait tone
#   triangle  — neon stroke colour

THEMES: dict[str, dict] = {
    "orange": {
        "backdrop": (10, 8, 12), "shadow": (14, 10, 8),
        "accent": (200, 106, 32), "highlight": (255, 217, 160),
        "triangle": (255, 106, 32),
    },
    # Derived from "orange" by pure hue rotation: HSV saturation and value are
    # byte-identical on every stop, so the blue portrait carries exactly the same
    # amount of tint as the orange one — only the hue differs. The rotation angle
    # (+169.2deg) is not a taste call either; it is the measured hue difference
    # between the two frame assets' own neon strokes, so the portrait tracks the
    # triangle it sits inside. Backdrop is the one exception: rotating a near-black
    # that leans violet lands it in green, so it keeps orange's saturation and
    # value but is placed in the blue family by hand.
    "blue": {
        "backdrop": (8, 11, 12), "shadow": (8, 13, 14),
        "accent": (32, 156, 200), "highlight": (160, 215, 255),
        "triangle": (32, 221, 255),
    },
    "magenta": {
        "backdrop": (12, 8, 16), "shadow": (16, 10, 20),
        "accent": (180, 74, 255), "highlight": (232, 192, 255),
        "triangle": (190, 80, 255),
    },
    "green": {
        "backdrop": (8, 14, 12), "shadow": (10, 18, 15),
        "accent": (46, 212, 122), "highlight": (184, 245, 208),
        "triangle": (46, 224, 130),
    },
    "violet": {
        "backdrop": (10, 8, 18), "shadow": (14, 11, 24),
        "accent": (139, 92, 246), "highlight": (216, 200, 255),
        "triangle": (150, 100, 255),
    },
}

DEFAULT_THEME = "orange"


def get_theme(name: str) -> dict:
    """Look up a theme, falling back to the default rather than raising."""
    return THEMES.get(name, THEMES[DEFAULT_THEME])


# ── Duotone mapping ──────────────────────────────────────────────────────────

def _build_lut(
    shadow: tuple[int, int, int],
    accent: tuple[int, int, int],
    highlight: tuple[int, int, int],
    mid: float = 0.55,
) -> np.ndarray:
    """
    Three-stop colour ramp as a 256x3 uint8 lookup table.

    `mid` is where the accent sits on the luminance axis. Pushing it above 0.5
    keeps more of the portrait in accent tones and reserves the top end for
    speculars, which is what stops faces looking washed out.
    """
    x = np.linspace(0.0, 1.0, 256)
    lut = np.zeros((256, 3), np.float32)
    for c in range(3):
        low = np.interp(x, [0.0, mid], [shadow[c], accent[c]])
        high = np.interp(x, [mid, 1.0], [accent[c], highlight[c]])
        lut[:, c] = np.where(x <= mid, low, high)
    return np.clip(lut, 0, 255).astype(np.uint8)


def make_duotone(
    img: Image.Image,
    theme: str = DEFAULT_THEME,
    *,
    presmooth: int = 1,
    bilateral_d: int = 7,
    bilateral_sigma: float = 40.0,
    clahe_clip: float = 2.2,
    clahe_grid: int = 8,
    black_point: float = 0.04,
    white_point: float = 0.98,
    gamma: float = 1.0,
    ramp_mid: float = 0.55,
    edge_feather: float = 1.2,
) -> Image.Image:
    """
    Map an RGBA cutout onto the theme's colour ramp, preserving alpha.

    Args:
        img:            RGBA subject cutout, post background removal.
        theme:          Key into THEMES.
        presmooth:      Bilateral passes — light, only to tame sensor noise.
        clahe_clip:     Local contrast boost; essential under flat booth lighting.
        black_point:    Luminance below this clips to the shadow tone.
        white_point:    Luminance above this clips to the highlight tone.
        ramp_mid:       Where the accent sits on the luminance axis.
        edge_feather:   Blur radius on alpha, to soften the cutout boundary.

    Returns:
        RGBA image, same size as input.
    """
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    rgb = np.array(img.convert("RGB"))
    alpha = np.array(img.getchannel("A"))
    colours = get_theme(theme)

    smoothed = rgb
    for _ in range(max(presmooth, 0)):
        smoothed = cv2.bilateralFilter(smoothed, bilateral_d, bilateral_sigma, bilateral_sigma)

    gray = cv2.cvtColor(smoothed, cv2.COLOR_RGB2GRAY)
    if clahe_clip > 0:
        gray = cv2.createCLAHE(clipLimit=clahe_clip, tileGridSize=(clahe_grid, clahe_grid)).apply(gray)

    # Normalise the tonal range, then apply the ramp
    g = gray.astype(np.float32) / 255.0
    g = np.clip((g - black_point) / max(white_point - black_point, 1e-6), 0.0, 1.0)
    if gamma != 1.0:
        g = np.power(g, gamma)

    lut = _build_lut(colours["shadow"], colours["accent"], colours["highlight"], mid=ramp_mid)
    toned = lut[(g * 255).astype(np.uint8)]

    out = Image.fromarray(np.dstack([toned, alpha]).astype(np.uint8), "RGBA")
    if edge_feather > 0:
        # Soften the matte edge so the figure sits in the scene rather than on it
        out.putalpha(out.getchannel("A").filter(ImageFilter.GaussianBlur(edge_feather)))
    return out


# ── Face-aware portrait framing (fallback when no capture guide was used) ─────

def portrait_crop(
    img: Image.Image,
    landmarks=None,
    *,
    aspect: float = 0.87,
    up: float = 1.55,
    down: float = 3.35,
) -> Image.Image:
    """
    Crop an RGBA cutout to head-and-shoulders framing around the detected face.

    Only used when the booth did NOT show a capture guide. When it did, the guest
    already composed the shot and re-cropping would discard their framing.

    `up` / `down` are multiples of the detected face height from the face centre.
    Without landmarks we assume an upright subject and take the top of the alpha
    bbox — wrong framing beats a crash mid-event.
    """
    W, H = img.width, img.height

    if landmarks is not None:
        fh = max(int(getattr(landmarks, "face_height", 0)), 8)
        top = landmarks.center_y - up * fh
        crop_h = (up + down) * fh
        crop_w = crop_h * aspect
        left = landmarks.center_x - crop_w / 2
    else:
        crop_h = H * 0.62
        crop_w = crop_h * aspect
        top = 0.0
        left = W / 2 - crop_w / 2

    left, top = int(round(left)), int(round(top))
    crop_w, crop_h = max(int(round(crop_w)), 1), max(int(round(crop_h)), 1)

    out = Image.new("RGBA", (crop_w, crop_h), (0, 0, 0, 0))
    sx0, sy0 = max(left, 0), max(top, 0)
    sx1, sy1 = min(left + crop_w, W), min(top + crop_h, H)
    if sx1 > sx0 and sy1 > sy0:
        out.paste(img.crop((sx0, sy0, sx1, sy1)), (sx0 - left, sy0 - top))
    return out


# ── Presets ──────────────────────────────────────────────────────────────────
# Tonal variants. Unlike the previous line renderer these differ in contrast and
# where the accent sits, not in line weight.

PRESETS: dict[str, dict] = {
    "duo_soft": {
        "clahe_clip": 1.6, "black_point": 0.02, "white_point": 1.0,
        "gamma": 0.95, "ramp_mid": 0.58, "presmooth": 1,
    },
    "duo_standard": {
        "clahe_clip": 2.2, "black_point": 0.04, "white_point": 0.98,
        "gamma": 1.0, "ramp_mid": 0.55, "presmooth": 1,
    },
    "duo_punch": {
        "clahe_clip": 3.0, "black_point": 0.07, "white_point": 0.95,
        "gamma": 1.08, "ramp_mid": 0.50, "presmooth": 0,
    },
}

DEFAULT_PRESET = "duo_standard"
RENDER_HEIGHT = 1350


def duotone_preset(
    img: Image.Image,
    preset: str = DEFAULT_PRESET,
    theme: str = DEFAULT_THEME,
    landmarks=None,
    *,
    auto_crop: bool = True,
    render_height: int = RENDER_HEIGHT,
) -> Image.Image:
    """
    Full render: optional portrait crop → normalise size → duotone map.

    Args:
        img:           RGBA subject cutout, post background removal.
        preset:        One of PRESETS.
        theme:         One of THEMES.
        landmarks:     FaceLandmarks for framing, or None.
        auto_crop:     Re-frame around the face. False when the guest already
                       framed themselves against the live capture guide.
        render_height: Target height. Never upscales — enlarging a small capture
                       interpolates detail away, so anything smaller is rendered
                       at its own resolution and enlarged by the compositor.

    Returns:
        RGBA duotone image, ready to composite onto the backdrop.
    """
    t0 = time.perf_counter()
    params = dict(PRESETS.get(preset, PRESETS[DEFAULT_PRESET]))

    cropped = portrait_crop(img, landmarks) if auto_crop else img
    t_crop = time.perf_counter() - t0

    t1 = time.perf_counter()
    effective_h = min(render_height, cropped.height) if cropped.height > 0 else render_height
    if effective_h != cropped.height and cropped.height > 0:
        target_w = max(int(effective_h * cropped.width / max(cropped.height, 1)), 1)
        scaled = cropped.resize((target_w, effective_h), Image.LANCZOS)
    else:
        scaled = cropped
    t_scale = time.perf_counter() - t1

    t2 = time.perf_counter()
    art = make_duotone(scaled, theme, **params)
    t_tone = time.perf_counter() - t2

    # Tonal spread inside the subject. A healthy portrait shows real modelling;
    # a near-zero spread means the face rendered as a flat blob, which is the
    # duotone equivalent of the empty-silhouette failure the line renderer had.
    a = np.array(scaled.getchannel("A"))
    subj = a > 140
    lum = np.array(art.convert("L"))
    spread = float(lum[subj].std()) if subj.any() else 0.0

    print(
        f"DUOTONE preset={preset} theme={theme} crop={t_crop * 1000:.0f}ms "
        f"scale={t_scale * 1000:.0f}ms tone={t_tone * 1000:.0f}ms "
        f"total={(time.perf_counter() - t0) * 1000:.0f}ms "
        f"in={img.width}x{img.height} render={art.width}x{art.height} "
        f"tonal_spread={spread:.1f} "
        f"framing={'face-crop' if auto_crop else 'guest-framed'}",
        flush=True,
    )
    return art
