"""
Geometric Overlay Service
=========================
Draws the procedural frame the duotone portrait sits inside: a near-black
backdrop and a large glowing neon triangle.

Everything is generated with PIL drawing ops rather than loaded from a PNG, so
the frame stays crisp at any output resolution and its colours can be themed per
event without an artist re-exporting assets.

The triangle is ISOCELES, not equilateral — it is defined by an apex height, a
base height and a base width, all as fractions of the canvas. The reference
artwork's triangle is taller than an equilateral one would be at that width, and
decoupling the three lets the frame adapt to any canvas aspect while still
enclosing a head-and-shoulders portrait.
"""

import os
from functools import lru_cache

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

# Fallbacks; real values come from the theme and the template JSON.
NEAR_BLACK = (10, 8, 12)
NEON_ORANGE = (255, 106, 32)

# Reference proportions — large enough that the portrait sits inside the frame
# rather than being a small figure floating in it.
DEFAULT_APEX_Y = 0.10
DEFAULT_BASE_Y = 0.90
DEFAULT_BASE_W = 0.92


def triangle_points(
    width: int,
    height: int,
    apex_y_ratio: float = DEFAULT_APEX_Y,
    base_y_ratio: float = DEFAULT_BASE_Y,
    base_width_ratio: float = DEFAULT_BASE_W,
) -> list[tuple[float, float]]:
    """
    Vertices of the isoceles frame triangle, in canvas pixels.

    Mirrors the same computation in the booth's capture guide (WebcamCapture.tsx)
    so the triangle the guest lines up against is the one that gets drawn.
    """
    cx = width / 2.0
    half = base_width_ratio * width / 2.0
    return [
        (cx, apex_y_ratio * height),                    # apex
        (cx + half, base_y_ratio * height),             # base right
        (cx - half, base_y_ratio * height),             # base left
    ]


def generate_dark_background(
    width: int,
    height: int,
    color: tuple[int, int, int] = NEAR_BLACK,
) -> Image.Image:
    """Solid backdrop canvas."""
    return Image.new("RGB", (width, height), color)


@lru_cache(maxsize=8)
def _load_frame(path: str, width: int, height: int, mtime: float) -> Image.Image:
    """
    Load a frame overlay PNG, resized to the canvas. Cached on (path, size, mtime)
    so editing the asset picks up without a restart but steady state costs nothing.
    """
    frame = Image.open(path).convert("RGBA")
    if (frame.width, frame.height) != (width, height):
        frame = frame.resize((width, height), Image.LANCZOS)
    return frame


def load_frame_overlay(path: str, width: int, height: int) -> Image.Image | None:
    """Frame overlay sized to the canvas, or None if it can't be read."""
    try:
        if path and os.path.exists(path):
            return _load_frame(path, width, height, os.path.getmtime(path))
    except Exception as e:
        print(f"WARNING: frame overlay load failed for {path}: {e}", flush=True)
    return None


@lru_cache(maxsize=8)
def _frame_backdrop_cached(path: str, mtime: float) -> tuple[int, int, int]:
    im = Image.open(path).convert("RGB")
    box = (0, 0, min(80, im.width), min(80, im.height))
    patch = np.array(im.crop(box)).reshape(-1, 3)
    return tuple(int(v) for v in patch.mean(axis=0).round())


def frame_backdrop(path: str) -> tuple[int, int, int] | None:
    """
    Sample the frame asset's own backdrop from a corner.

    The area inside the window is filled by us and the area outside comes from the
    asset. If the two differ the triangle reads as a darker hole punched in the
    art rather than a window onto it, so we match the canvas to the asset.
    """
    try:
        if path and os.path.exists(path):
            return _frame_backdrop_cached(path, os.path.getmtime(path))
    except Exception as e:
        print(f"WARNING: frame backdrop sample failed for {path}: {e}", flush=True)
    return None


def generate_neon_triangle_overlay(
    width: int,
    height: int,
    *,
    triangle_color: tuple[int, int, int] = NEON_ORANGE,
    apex_y_ratio: float = DEFAULT_APEX_Y,
    base_y_ratio: float = DEFAULT_BASE_Y,
    base_width_ratio: float = DEFAULT_BASE_W,
    line_width: int = 11,
    glow_radius: int = 34,
    glow_opacity: float = 0.42,
) -> Image.Image:
    """
    Neon-glowing triangle outline on transparency.

    The glow is a heavily blurred, thicker copy of the same triangle composited
    beneath the crisp stroke — cheaper and more controllable than a real bloom,
    and it survives JPEG encoding better than a soft gradient would.
    """
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    points = triangle_points(width, height, apex_y_ratio, base_y_ratio, base_width_ratio)
    closed = points + [points[0]]
    stroke = triangle_color + (255,)

    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(glow).line(closed, fill=stroke, width=line_width + glow_radius, joint="curve")
    glow = glow.filter(ImageFilter.GaussianBlur(glow_radius))
    faded = np.array(glow.getchannel("A")).astype(np.float32) * glow_opacity
    glow.putalpha(Image.fromarray(np.clip(faded, 0, 255).astype(np.uint8)))
    canvas = Image.alpha_composite(canvas, glow)

    line = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(line).line(closed, fill=stroke, width=line_width, joint="curve")
    return Image.alpha_composite(canvas, line)


def compose_duotone_artwork(
    subject: Image.Image,
    *,
    canvas_width: int = 1080,
    canvas_height: int = 1350,
    bg_color: tuple[int, int, int] = NEAR_BLACK,
    triangle_color: tuple[int, int, int] = NEON_ORANGE,
    apex_y_ratio: float = DEFAULT_APEX_Y,
    base_y_ratio: float = DEFAULT_BASE_Y,
    base_width_ratio: float = DEFAULT_BASE_W,
    line_width: int = 11,
    glow_radius: int = 34,
    frame_path: str | None = None,
    match_frame_backdrop: bool = True,
    backdrop_image: Image.Image | None = None,
    fit: str = "frame",
    subject_height_ratio: float = 0.80,
    subject_center_y_ratio: float = 0.56,
) -> Image.Image:
    """
    Final artwork composition.

    With a `frame_path` (the normal case), the frame PNG is a pre-keyed matte:
    opaque everywhere except a transparent triangle. Order is

      1. Near-black backdrop
      2. Duotone portrait, full canvas
      3. Frame PNG on top

    so the frame physically covers everything outside the triangle. Nothing can
    escape the window, and the artwork lines up with the capture preview exactly,
    because the preview overlays the same file.

    Without a frame asset it falls back to drawing the triangle procedurally, in
    which case the portrait sits in FRONT of the stroke.

    Two fit modes:

    - "frame" (default) — the guest composed the shot against the live triangle
      guide, so the portrait maps onto the canvas 1:1 (cover). What they lined up
      in the viewfinder is what lands in the artwork.

    - "portrait" — no guide was used, so the subject is a face-cropped portrait
      that gets scaled by height and centred.

    Returns:
        RGB image — the final artwork.
    """
    frame = load_frame_overlay(frame_path, canvas_width, canvas_height) if frame_path else None

    # Match the canvas to the asset's own backdrop so the window is seamless
    if frame is not None and match_frame_backdrop:
        sampled = frame_backdrop(frame_path)
        if sampled is not None:
            bg_color = sampled

    if backdrop_image is not None:
        # Watercolor mode supplies a rendered plexus field here. It replaces only
        # the flat fill; the frame still composites last and still clips
        # everything to the triangle, so the matte guarantees are unchanged.
        bd = backdrop_image.convert("RGB")
        if (bd.width, bd.height) != (canvas_width, canvas_height):
            bd = bd.resize((canvas_width, canvas_height), Image.LANCZOS)
        canvas = bd.convert("RGBA")
    else:
        canvas = generate_dark_background(canvas_width, canvas_height, bg_color).convert("RGBA")

    if frame is None:
        # No asset — draw the triangle behind the subject instead
        canvas = Image.alpha_composite(canvas, generate_neon_triangle_overlay(
            canvas_width, canvas_height,
            triangle_color=triangle_color,
            apex_y_ratio=apex_y_ratio,
            base_y_ratio=base_y_ratio,
            base_width_ratio=base_width_ratio,
            line_width=line_width,
            glow_radius=glow_radius,
        ))

    if subject.mode != "RGBA":
        subject = subject.convert("RGBA")

    if fit == "frame":
        # Cover the canvas, centre-cropping any excess — mirrors the
        # `object-fit: cover` the capture preview uses, so guide and artwork align.
        src_ratio = subject.width / max(subject.height, 1)
        dst_ratio = canvas_width / max(canvas_height, 1)
        if src_ratio > dst_ratio:
            scale_h = canvas_height
            scale_w = max(int(round(scale_h * src_ratio)), 1)
        else:
            scale_w = canvas_width
            scale_h = max(int(round(scale_w / max(src_ratio, 1e-6))), 1)
        resized = subject.resize((scale_w, scale_h), Image.LANCZOS)
        paste_x = (canvas_width - scale_w) // 2
        paste_y = (canvas_height - scale_h) // 2
    else:
        target_h = max(int(canvas_height * subject_height_ratio), 1)
        target_w = max(int(target_h * subject.width / max(subject.height, 1)), 1)
        max_w = int(canvas_width * 0.96)
        if target_w > max_w:
            target_w = max_w
            target_h = max(int(target_w * subject.height / max(subject.width, 1)), 1)
        resized = subject.resize((target_w, target_h), Image.LANCZOS)
        paste_x = (canvas_width - target_w) // 2
        paste_y = int(canvas_height * subject_center_y_ratio) - target_h // 2

    canvas.alpha_composite(resized, (paste_x, paste_y))

    # Frame last — it is the matte that clips the portrait to the triangle
    if frame is not None:
        canvas = Image.alpha_composite(canvas, frame)

    return canvas.convert("RGB")
