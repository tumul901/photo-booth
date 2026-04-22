# Phase 1 — Backend: Template JSON Schema & TemplateMetadata Extension

## Goal
Extend the `TemplateMetadata` dataclass and `load_template_metadata()` in
`backend/services/compose.py` to carry text-rendering config for `NAME` and
`DESIGNATION`. These config blocks tell the Pillow text-drawing step (Phase 3)
exactly where and how to draw dynamic text on the canvas.

**No other file changes in this phase.**

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| `TemplateMetadata` dataclass | ✅ exists in `backend/services/compose.py` lines 58-70 |
| `fg_path: str = ""` field | ✅ already on `TemplateMetadata` |
| `load_template_metadata()` | ✅ exists, reads JSON and builds `TemplateMetadata` |
| `compositeMode: "magazine"` in JSON | ✅ already written by admin |
| Text config in template JSON | ❌ does not exist yet |
| Text config in `TemplateMetadata` | ❌ does not exist yet |

---

## Changes Required

### File: `backend/services/compose.py`

#### 1. Add a new dataclass `MagazineTextConfig`

Insert this **above** the `TemplateMetadata` dataclass (around line 40):

```python
@dataclass
class MagazineTextConfig:
    """
    Configuration for rendering a single dynamic text element (NAME or DESIGNATION)
    on the magazine canvas using Pillow ImageDraw.

    Coordinates are in the template's native pixel space (matching the dimensions
    stored in the JSON). They are scaled by res_multiplier at render time.
    """
    x: int                      # Left edge of text in template-native pixels
    y: int                      # Top edge of text in template-native pixels
    font_size: int              # Font size in template-native pixels (scaled at render)
    color: str = "#FFFFFF"      # CSS hex color, e.g. "#FFFFFF" or "white"
    font_path: str = ""         # Absolute path to a .ttf font file; empty = use default
    max_width: int = 0          # If > 0, text is clamped/wrapped to this width (native px)
    align: str = "left"         # "left", "center", "right"
    uppercase: bool = False     # If True, force text to uppercase before drawing
```

#### 2. Extend `TemplateMetadata` dataclass

Add two optional fields at the **bottom** of the `TemplateMetadata` dataclass
(after `fg_path: str = ""`):

```python
    # Magazine mode: dynamic text positions
    name_text: Optional['MagazineTextConfig'] = None         # Where to draw the person's name
    designation_text: Optional['MagazineTextConfig'] = None  # Where to draw their designation
```

The import `Optional` is already present via `from typing import ... Optional`.

#### 3. Update `load_template_metadata()` — parse text config from JSON

Inside the `try` block in `load_template_metadata()`, after the line that builds
the `return TemplateMetadata(...)` object (currently around line 154), add a
parsing step **before** the `return` statement:

```python
# --- Magazine text config ---
def _parse_text_cfg(raw: dict) -> Optional[MagazineTextConfig]:
    if not raw:
        return None
    return MagazineTextConfig(
        x=int(raw.get("x", 0)),
        y=int(raw.get("y", 0)),
        font_size=int(raw.get("fontSize", 60)),
        color=raw.get("color", "#FFFFFF"),
        font_path=raw.get("fontPath", ""),
        max_width=int(raw.get("maxWidth", 0)),
        align=raw.get("align", "left"),
        uppercase=bool(raw.get("uppercase", False)),
    )

name_text_cfg = _parse_text_cfg(data.get("name_text", {}))
designation_text_cfg = _parse_text_cfg(data.get("designation_text", {}))
```

Then pass them to the returned object:

```python
return TemplateMetadata(
    ...  # all existing fields unchanged
    name_text=name_text_cfg,
    designation_text=designation_text_cfg,
)
```

---

## Template JSON Schema — New Fields

When a magazine template is configured, the JSON file (`templates/{id}.json`)
will contain two new top-level keys. Example:

```json
{
  "templateId": "haleon-growth-story",
  "compositeMode": "magazine",
  "png_path": "haleon-growth-story_bg.png",
  "fg_path": "haleon-growth-story_fg.png",
  "name_text": {
    "x": 248,
    "y": 1240,
    "fontSize": 72,
    "color": "#FFFFFF",
    "fontPath": "",
    "maxWidth": 780,
    "align": "left",
    "uppercase": true
  },
  "designation_text": {
    "x": 248,
    "y": 1330,
    "fontSize": 36,
    "color": "#FFFFFF",
    "fontPath": "",
    "maxWidth": 780,
    "align": "left",
    "uppercase": false
  }
}
```

**Coordinate system**: All `x`, `y`, `fontSize`, `maxWidth` values are in the
template's **native pixel space** (i.e., matching `dimensions.width` ×
`dimensions.height`). At render time Phase 3 multiplies every coordinate by
`res_multiplier` before drawing.

**fontPath**: Leave empty string `""` to use Pillow's built-in default font.
To use a custom TTF, supply the absolute server path (e.g.
`/app/fonts/BebasNeue-Regular.ttf`). Phase 3 falls back to the default font if
the path does not exist.

---

## Defaults for Non-Magazine Templates

`name_text` and `designation_text` default to `None` in the dataclass.
`_parse_text_cfg({})` also returns `None` when given an empty dict or a missing
key. Non-magazine templates simply never have these keys in their JSON so the
fields stay `None` and Phase 3 skips all text drawing entirely.

---

## Test Checklist (manual)

1. Open any existing non-magazine template JSON. Load it via
   `load_template_metadata()`. Verify `meta.name_text is None` and
   `meta.designation_text is None`.
2. Add `name_text` and `designation_text` blocks to a magazine template JSON.
   Reload (call `clear_template_cache()` first). Verify the returned
   `TemplateMetadata` has `name_text.x`, `name_text.font_size`, etc. set
   correctly.
3. Omit `fontPath` from the JSON. Verify `MagazineTextConfig.font_path == ""`.
4. Confirm no import errors and the app boots (`uvicorn main:app`).

---

## What This Phase Does NOT Do

- Does not draw any text (that is Phase 3)
- Does not modify the admin endpoints (that is Phase 4)
- Does not touch the frontend
- Does not add or modify any API routes
