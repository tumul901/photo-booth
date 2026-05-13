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

from PIL import Image, ImageColor, ImageFilter

# Exported for validation. Keep in sync with feature_flags_service.STICKER_EFFECT_NAMES.
EFFECT_NAMES = ("none", "stroke", "shadow", "unsharp", "alpha_matting")


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
