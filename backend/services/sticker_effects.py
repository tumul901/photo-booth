"""
Sticker Edge Effects
====================
Post-processing passes applied to the rembg cutout before it's returned to the
compositing pipeline.

All effects are pure functions: take an RGBA PIL image, return an RGBA PIL image.
Effects may grow the canvas (stroke adds outline padding, shadow adds offset+blur
padding). The downstream crop_to_alpha_bbox handles re-tightening if needed.

Effects supported here:
- stroke     : solid-color outline around the alpha boundary (sticker look)
- shadow     : soft drop shadow cast behind the cutout (depth, hides edge issues)
- unsharp    : sharpen RGB to recover detail lost in segmentation downscale

`alpha_matting` is NOT here — it has to run inside rembg.remove() itself, so it's
handled directly in rembg_service._remove_sync().
"""

import time

import numpy as np
from PIL import Image, ImageColor, ImageFilter

# Exported for validation. Keep in sync with feature_flags_service.STICKER_EFFECT_NAMES.
EFFECT_NAMES = ("none", "stroke", "shadow", "unsharp", "alpha_matting")


def clean_alpha_islands(
    img: Image.Image,
    low_alpha_cut: int = 12,
    min_area_frac: float = 0.02,
) -> Image.Image:
    """
    Kill segmentation ghosts: faint translucent leftovers of the original
    background and small disconnected blobs that rembg sometimes keeps.

    Two steps:
      1. Hard-zero any pixel below `low_alpha_cut` — removes the near-transparent
         haze that shows up as a ghost when composited on a new background.
      2. Keep only connected foreground components whose area is >= `min_area_frac`
         of the largest component. The subject is one big blob; floating shadow
         chunks / a bystander's arm in the corner are small and get dropped.

    Conservative by design — `min_area_frac=0.02` keeps anything substantial
    (e.g. a raised hand that's still 2%+ of the subject) while removing specks.
    """
    t0 = time.perf_counter()
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    rgba = np.array(img)
    alpha = rgba[..., 3]

    alpha = np.where(alpha < low_alpha_cut, 0, alpha)
    binary = (alpha > 0).astype(np.uint8)

    dropped = 0
    try:
        import cv2
        num, labels, stats, _ = cv2.connectedComponentsWithStats(binary, connectivity=8)
        if num > 1:
            areas = stats[1:, cv2.CC_STAT_AREA]  # skip background label 0
            largest = int(areas.max())
            keep = np.zeros(num, dtype=bool)
            for lbl in range(1, num):
                if stats[lbl, cv2.CC_STAT_AREA] >= min_area_frac * largest:
                    keep[lbl] = True
                else:
                    dropped += 1
            keep_mask = keep[labels]
            alpha = np.where(keep_mask, alpha, 0)
    except Exception as e:
        print(f"WARNING: clean_alpha_islands cv2 unavailable ({e}); low-alpha cut only", flush=True)

    rgba[..., 3] = alpha
    print(
        f"EFFECT [clean_islands] low_cut={low_alpha_cut} min_area_frac={min_area_frac} "
        f"dropped={dropped} blobs {img.width}x{img.height} in {(time.perf_counter() - t0) * 1000:.0f}ms",
        flush=True,
    )
    return Image.fromarray(rgba, "RGBA")


def decontaminate_edges(
    img: Image.Image,
    grow: int = 4,
    shrink: int = 1,
    core_alpha: int = 200,
) -> Image.Image:
    """
    Remove the colored "bleed"/halo around a cutout — background-independent.

    The segmentation network leaves a soft, semi-transparent ring of pixels at the
    subject boundary whose RGB still contains the *original* background colour. When
    composited onto a new template that ring shows up as a halo (e.g. a dark fringe
    around a white shirt on a yellow background).

    Fix, in two cheap passes (works for any background, no green screen needed):
      1. `shrink` — erode the alpha by N px to cut the outermost, most-contaminated ring.
      2. `grow`   — extrapolate the *foreground* colour outward into the remaining edge
                    band (grass-fire fill from the opaque core). Any soft edge that
                    survives now carries the subject's own colour, so it blends into the
                    person instead of flashing the old background.

    Only RGB of edge pixels is changed; the (eroded) alpha continues to provide the
    soft matte, so hair/edges stay smooth.

    Args:
      grow       — px of foreground-colour extrapolation into the edge band
      shrink     — px of alpha erosion to trim the outer contaminated ring (0 = off)
      core_alpha — pixels with alpha >= this are treated as trusted foreground colour
    """
    t0 = time.perf_counter()
    if img.mode != "RGBA":
        img = img.convert("RGBA")

    rgba = np.array(img)
    rgb = rgba[..., :3].astype(np.float32)
    alpha = rgba[..., 3]

    # 1) erode alpha to remove the outermost contaminated ring
    out_alpha = alpha
    if shrink > 0:
        try:
            import cv2
            k = np.ones((3, 3), np.uint8)
            out_alpha = cv2.erode(alpha, k, iterations=shrink)
        except Exception:
            # Pillow fallback: MinFilter shrinks the bright (opaque) region
            size = shrink * 2 + 1
            out_alpha = np.asarray(Image.fromarray(alpha).filter(ImageFilter.MinFilter(size)))

    # 2) grow foreground colour outward (grass-fire fill) so the surviving soft edge
    #    takes the subject's colour rather than the old background's.
    known = (alpha >= core_alpha).astype(np.float32)
    if known.any():
        try:
            import cv2
            blur = lambda a: cv2.blur(a, (3, 3))
        except Exception:
            def blur(a):
                return np.asarray(
                    Image.fromarray(a.astype(np.float32)).filter(ImageFilter.BoxBlur(1)),
                    dtype=np.float32,
                )
        for _ in range(max(0, grow)):
            num = blur(rgb * known[..., None])
            den = blur(known)
            newmask = (den > 1e-3) & (known < 0.5)
            if not newmask.any():
                break
            filled = num / (den[..., None] + 1e-6)
            rgb[newmask] = filled[newmask]
            known[newmask] = 1.0

    result = np.dstack([np.clip(rgb, 0, 255).astype(np.uint8), out_alpha]).astype(np.uint8)
    print(
        f"EFFECT [decontaminate] grow={grow} shrink={shrink} "
        f"{img.width}x{img.height} in {(time.perf_counter() - t0) * 1000:.0f}ms",
        flush=True,
    )
    return Image.fromarray(result, "RGBA")


def apply_stroke(
    img: Image.Image,
    width: int = 4,
    color: str = "#FFFFFF",
) -> Image.Image:
    """
    Add a solid-color outline around the alpha boundary of the cutout.

    Implementation:
      1. Pad the canvas so the outline isn't clipped at the edges.
      2. Dilate the alpha channel by `width` pixels (MaxFilter).
      3. Build a solid-colored layer with that dilated alpha as its mask.
      4. Composite the original cutout on top.

    The padded transparent border means the stroke also wraps around any edge
    where the subject was clipped by the original image bounds (e.g. the bottom
    of the torso when a portrait gets cropped) — exactly the sticker look you'd
    expect.

    Args:
      width — stroke thickness in pixels of the *unscaled* cutout space
      color — any CSS-style color string ("#FFFFFF", "white", "rgb(...)")
    """
    t0 = time.perf_counter()
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    in_size = (img.width, img.height)

    # Pad so MaxFilter has room to grow without clipping at canvas edge.
    # +2 absorbs the kernel half-width plus a 1-px safety margin.
    pad = width + 2
    padded = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))
    padded.paste(img, (pad, pad), img)

    # MaxFilter kernel size must be odd; 2*width+1 dilates by `width` pixels each side.
    kernel = max(3, width * 2 + 1)
    dilated_alpha = padded.getchannel("A").filter(ImageFilter.MaxFilter(size=kernel))

    rgb = ImageColor.getrgb(color)
    stroke_layer = Image.new("RGBA", padded.size, rgb + (0,))
    stroke_layer.putalpha(dilated_alpha)

    result = Image.alpha_composite(stroke_layer, padded)
    print(
        f"EFFECT [stroke] width={width} color={color} kernel={kernel}px "
        f"{in_size[0]}x{in_size[1]} -> {result.width}x{result.height} "
        f"in {(time.perf_counter() - t0) * 1000:.0f}ms",
        flush=True,
    )
    return result


def apply_drop_shadow(
    img: Image.Image,
    offset: tuple[int, int] = (6, 10),
    blur: int = 10,
    opacity: float = 0.45,
    color: str = "#000000",
) -> Image.Image:
    """
    Cast a soft drop shadow behind the cutout.

    The shadow is the cutout's alpha tinted dark, offset by (ox, oy), then
    Gaussian-blurred. Adds padding so the shadow isn't clipped.

    Args:
      offset   — (x, y) pixel offset in unscaled cutout space (positive = right/down)
      blur     — Gaussian blur radius in pixels
      opacity  — 0..1 multiplier on the shadow's alpha
      color    — shadow color (default black)
    """
    t0 = time.perf_counter()
    if img.mode != "RGBA":
        img = img.convert("RGBA")
    in_size = (img.width, img.height)

    ox, oy = offset
    pad = max(blur * 2, abs(ox), abs(oy)) + 4

    canvas = Image.new("RGBA", (img.width + pad * 2, img.height + pad * 2), (0, 0, 0, 0))

    # Shadow = cutout alpha * opacity, tinted with `color`.
    alpha = img.getchannel("A")
    shadow_alpha = alpha.point(lambda v: int(v * opacity))
    rgb = ImageColor.getrgb(color)
    shadow_tile = Image.new("RGBA", img.size, rgb + (0,))
    shadow_tile.putalpha(shadow_alpha)

    # Paste offset, then blur the entire canvas (cheap — only the shadow has content).
    canvas.paste(shadow_tile, (pad + ox, pad + oy), shadow_tile)
    canvas = canvas.filter(ImageFilter.GaussianBlur(radius=blur))

    # Composite original cutout on top.
    canvas.alpha_composite(img, (pad, pad))
    print(
        f"EFFECT [shadow] offset=({ox},{oy}) blur={blur} opacity={opacity:.2f} color={color} "
        f"{in_size[0]}x{in_size[1]} -> {canvas.width}x{canvas.height} "
        f"in {(time.perf_counter() - t0) * 1000:.0f}ms",
        flush=True,
    )
    return canvas


def apply_unsharp(
    img: Image.Image,
    radius: float = 1.5,
    percent: int = 130,
    threshold: int = 2,
) -> Image.Image:
    """
    Run PIL's UnsharpMask on the RGB channels only. Recovers high-frequency
    detail lost when the input was downsized for segmentation. Alpha is
    untouched (otherwise we'd reintroduce the very edge artifacts we're trying
    to smooth).
    """
    t0 = time.perf_counter()
    if img.mode != "RGBA":
        result = img.filter(ImageFilter.UnsharpMask(radius, percent, threshold))
    else:
        r, g, b, a = img.split()
        rgb = Image.merge("RGB", (r, g, b))
        rgb = rgb.filter(ImageFilter.UnsharpMask(radius, percent, threshold))
        r2, g2, b2 = rgb.split()
        result = Image.merge("RGBA", (r2, g2, b2, a))
    print(
        f"EFFECT [unsharp] radius={radius} percent={percent} threshold={threshold} "
        f"{img.width}x{img.height} (RGB-only, alpha preserved) "
        f"in {(time.perf_counter() - t0) * 1000:.0f}ms",
        flush=True,
    )
    return result
