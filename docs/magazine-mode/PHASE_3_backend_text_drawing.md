# Phase 3 — Backend: Pillow Text Drawing for Magazine Mode

## Goal
After the FG PNG overlay is composited (the existing magazine layer logic in
`compose_final`), draw the person's `NAME` and `DESIGNATION` onto the canvas
using `Pillow.ImageDraw`. The coordinates, font size, colour and alignment come
from `TemplateMetadata.name_text` and `TemplateMetadata.designation_text` (added
in Phase 1). The text values come from the `magazine_name` / `magazine_designation`
params added in Phase 2.

**Only file changed: `backend/services/compose.py`**

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| Magazine FG overlay block in `compose_final` | ✅ lines 556-566 of compose.py |
| `fg_template_path` param on `compose_final` | ✅ exists |
| `magazine_name` / `magazine_designation` stubs | ✅ added in Phase 2 |
| `MagazineTextConfig` dataclass | ✅ added in Phase 1 |
| `TemplateMetadata.name_text` / `.designation_text` | ✅ added in Phase 1 |
| Pillow `ImageDraw` / `ImageFont` | ✅ Pillow is already a dependency |

---

## Changes Required

### File: `backend/services/compose.py`

#### 1. Add a helper method `_draw_magazine_text` to `ComposeService`

Place this method inside the `ComposeService` class, **before** `compose_final`.

```python
def _draw_magazine_text(
    self,
    canvas: Image.Image,
    text: str,
    cfg: 'MagazineTextConfig',
    res_multiplier: float,
) -> None:
    """
    Draw a single line of text on the canvas in-place using Pillow ImageDraw.

    All native-pixel coordinates in cfg are scaled by res_multiplier so the
    text renders correctly regardless of the canvas upscaling applied in
    compose_final.

    Args:
        canvas       — The RGBA canvas to draw onto (mutated in-place)
        text         — The string to draw (name or designation)
        cfg          — MagazineTextConfig loaded from the template JSON
        res_multiplier — The same multiplier used to scale the canvas in compose_final
    """
    from PIL import ImageDraw, ImageFont

    if not text or not text.strip():
        return

    # Apply uppercase if configured
    display_text = text.upper() if cfg.uppercase else text

    # Scale coordinates to the upscaled canvas space
    x = int(cfg.x * res_multiplier)
    y = int(cfg.y * res_multiplier)
    font_size = int(cfg.font_size * res_multiplier)
    max_width = int(cfg.max_width * res_multiplier) if cfg.max_width > 0 else 0

    # Load font
    font = None
    if cfg.font_path and os.path.exists(cfg.font_path):
        try:
            font = ImageFont.truetype(cfg.font_path, font_size)
        except Exception as e:
            print(f"WARNING: Could not load font {cfg.font_path}: {e}. Using default.", flush=True)

    if font is None:
        # Pillow built-in default — no TTF needed, always available
        # Note: default font ignores size; this is a fallback only
        try:
            # Try to load a common system font as a better fallback
            for fallback in [
                "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                "C:/Windows/Fonts/arial.ttf",
            ]:
                if os.path.exists(fallback):
                    font = ImageFont.truetype(fallback, font_size)
                    break
        except Exception:
            pass

    if font is None:
        font = ImageFont.load_default()

    # Parse colour (supports "#RRGGBB" and named colours like "white")
    try:
        from PIL import ImageColor
        rgb = ImageColor.getrgb(cfg.color)
        colour_rgba = rgb + (255,) if len(rgb) == 3 else rgb
    except Exception:
        colour_rgba = (255, 255, 255, 255)

    draw = ImageDraw.Draw(canvas)

    # If max_width is set, truncate text to fit (single line only — no wrapping)
    if max_width > 0:
        # Linear pruning: trim one char at a time until it fits
        truncated = False
        while len(display_text) > 1:
            bbox = draw.textbbox((0, 0), display_text, font=font)
            text_w = bbox[2] - bbox[0]
            if text_w <= max_width:
                break
            display_text = display_text[:-1]
            truncated = True
        if truncated and len(display_text) > 3:
            display_text = display_text[:-1] + '…'  # Add ellipsis when truncated

    # Alignment offset
    if cfg.align in ("center", "right"):
        bbox = draw.textbbox((0, 0), display_text, font=font)
        text_w = bbox[2] - bbox[0]
        if cfg.align == "center":
            ref_w = max_width if max_width > 0 else (canvas.width - x)
            x = x + (ref_w - text_w) // 2
        else:  # right
            ref_w = max_width if max_width > 0 else (canvas.width - x)
            x = x + ref_w - text_w

    draw.text((x, y), display_text, font=font, fill=colour_rgba)
    print(f"DEBUG Magazine Text: drew '{display_text}' at ({x},{y}) size={font_size}", flush=True)
```

#### 2. Call `_draw_magazine_text` inside the existing magazine block in `compose_final`

The existing magazine block (lines 556-566 in compose.py) currently looks like:

```python
# --- MAGAZINE MODE: FG overlay on top of user cutout ---
if template_meta.composite_mode == "magazine":
    if fg_template_path and os.path.exists(fg_template_path):
        fg = _get_resized_template(fg_template_path, canvas_w, canvas_h)
        canvas = Image.alpha_composite(canvas, fg)
        print(f"DEBUG Compose: Magazine FG overlay applied: {os.path.basename(fg_template_path)}", flush=True)
    else:
        print(f"DEBUG Compose: Magazine mode but no FG path provided or file missing: {fg_template_path}", flush=True)
    return canvas
```

**Replace** this entire block with:

```python
# --- MAGAZINE MODE: FG overlay on top of user cutout ---
if template_meta.composite_mode == "magazine":
    # Step 1 — composite FG PNG over the user cutout
    if fg_template_path and os.path.exists(fg_template_path):
        fg = _get_resized_template(fg_template_path, canvas_w, canvas_h)
        canvas = Image.alpha_composite(canvas, fg)
        print(f"DEBUG Compose: Magazine FG overlay applied: {os.path.basename(fg_template_path)}", flush=True)
    else:
        print(f"DEBUG Compose: Magazine mode but no FG path or file missing: {fg_template_path}", flush=True)

    # Step 2 — draw NAME text (if configured and provided)
    if magazine_name and template_meta.name_text:
        self._draw_magazine_text(
            canvas=canvas,
            text=magazine_name,
            cfg=template_meta.name_text,
            res_multiplier=res_multiplier,
        )
    elif magazine_name:
        print("DEBUG Compose: magazine_name provided but name_text config missing in template JSON", flush=True)

    # Step 3 — draw DESIGNATION text (if configured and provided)
    if magazine_designation and template_meta.designation_text:
        self._draw_magazine_text(
            canvas=canvas,
            text=magazine_designation,
            cfg=template_meta.designation_text,
            res_multiplier=res_multiplier,
        )
    elif magazine_designation:
        print("DEBUG Compose: magazine_designation provided but designation_text config missing in template JSON", flush=True)

    return canvas
```

---

## Important: `res_multiplier` is already computed

`res_multiplier` is computed early in `compose_final`:

```python
res_multiplier = max(1.0, 1080 / min(template_meta.width, template_meta.height))
canvas_w = int(template_meta.width * res_multiplier)
canvas_h = int(template_meta.height * res_multiplier)
```

The `_draw_magazine_text` helper receives this and applies it to all coordinates,
so the text lands at the correct position regardless of upscaling.

---

## Font Strategy

| Priority | Source | Condition |
|----------|--------|-----------|
| 1 | `cfg.font_path` (custom TTF) | Path exists on disk |
| 2 | DejaVuSans-Bold (Linux) | File present at system path |
| 3 | LiberationSans-Bold (Linux) | File present at system path |
| 4 | Arial (Windows) | File present at system path |
| 5 | Pillow built-in bitmap font | Always available, no size scaling |

For production (Haleon), the designer should supply a `BebasNeue-Regular.ttf`
or similar, bundled in the Docker image (e.g. at `/app/fonts/BebasNeue.ttf`),
and the template JSON sets `"fontPath": "/app/fonts/BebasNeue.ttf"`.

---

## Text Does NOT Break the FG

Because text is drawn **after** `alpha_composite(canvas, fg)`, the FG PNG is
already on the canvas. Text is drawn on top of both user and FG. This is correct
because the FG semi-transparent bottom bar (63% opacity) sits below the text,
exactly replicating the designer's intent.

If the FG PNG has fully opaque pixels at the text coordinates (i.e. the bottom
bar area), the text simply renders on top of the bar — which is correct.

---

## Test Checklist (manual)

1. Set up a magazine template with `name_text` and `designation_text` in its JSON (use
   the example from Phase 1).
2. POST to `/api/generate` with:
   - `processing_mode=sticker`
   - `magazine_name=Jane Smith`
   - `magazine_designation=Head of Marketing`
3. Open the output image. Verify name and designation appear at the correct
   position in the expected colour and size.
4. POST without `magazine_name` — verify no error, no text drawn.
5. POST with a non-magazine template and `magazine_name` set — verify text is
   NOT drawn (non-magazine templates skip the magazine block).
6. Verify that the existing sticker / frame modes are completely unaffected.

---

## What This Phase Does NOT Do

- Does not add font files to the Docker image (Phase 4 or separate ops task)
- Does not create the admin UI for configuring text positions (Phase 4)
- Does not modify the frontend (Phases 5–7)
- Does not handle multi-line wrapping — single-line truncation only
