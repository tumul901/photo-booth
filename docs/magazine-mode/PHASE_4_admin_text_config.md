# Phase 4 — Backend: Admin Endpoints for Text Position Config

## Goal
Allow the admin to save `name_text` and `designation_text` position configs into
the template JSON via the existing `PUT /api/admin/templates/{id}/config` endpoint.
Also expose a `GET /api/admin/templates/{id}/config` endpoint so the frontend
admin panel can read the current config back.

**Only file changed: `backend/api/admin.py`**

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| `PUT /api/admin/templates/{id}/config` | ✅ exists (TemplateConfigUpdate model, ~line 249) |
| `GET /api/admin/templates/{id}/config` | ✅ already exists (~line 339) |
| `TemplateConfigUpdate` Pydantic model | ✅ exists (~line 231), needs new fields |
| FG upload (`POST /templates/{id}/fg`) | ✅ exists, already accepts any extension |
| FG image serve (`GET /templates/{id}/fg-image`) | ✅ exists |

---

## Changes Required

### File: `backend/api/admin.py`

#### 1. Add nested Pydantic model `TextConfig`

Add this **above** `TemplateConfigUpdate`:

```python
class TextConfig(BaseModel):
    """
    Position and style for a single dynamic text element (name or designation)
    rendered by Pillow at photo generation time.
    All pixel values are in the template's native coordinate space.
    """
    x: int = 0
    y: int = 0
    fontSize: int = 60         # Maps to MagazineTextConfig.font_size
    color: str = "#FFFFFF"
    fontPath: str = ""         # Absolute server path to TTF; empty = system default
    maxWidth: int = 0          # 0 = no limit
    align: str = "left"        # "left" | "center" | "right"
    uppercase: bool = False
```

#### 2. Extend `TemplateConfigUpdate` with two new optional fields

Current class (around line 231):

```python
class TemplateConfigUpdate(BaseModel):
    templateId: str
    name: str
    templateType: str
    compositeMode: str
    pngUrl: str
    fg_path: str = ""
    anchorMode: str
    dimensions: dict
    slots: List[SlotConfig]
    desiredFaceRatio: float
    minZoom: float
    maxZoom: float
    stickerFilter: str = "none"
    showVisualGuide: bool = False
    allowManualPositioning: bool = False
```

Add at the bottom:

```python
    name_text: Optional[TextConfig] = None        # NEW — magazine name text position
    designation_text: Optional[TextConfig] = None  # NEW — magazine designation text position
```

Also ensure `Optional` is imported — add to the existing import line if needed:
```python
from typing import List, Optional
```

#### 3. Update `PUT /templates/{id}/config` to persist text configs

Inside the `update_template_config()` handler, find where `template_json` is
built (around line 287). The dict currently ends around line 320. Add the two
text config fields **inside** `template_json`:

```python
# Inside template_json = { ... }:

# Magazine text overlay config (only written if provided)
"name_text": config.name_text.model_dump() if config.name_text else existing_meta.get("name_text", {}),
"designation_text": config.designation_text.model_dump() if config.designation_text else existing_meta.get("designation_text", {}),
```

The Pydantic `.model_dump()` method (Pydantic v2) serialises the `TextConfig` to
a plain dict that matches the JSON schema defined in Phase 1. When the admin panel
sends `null` for a text config (e.g. template is not a magazine template), the
existing value from disk is preserved.

> **Important: Config Preservation** — The current `update_template_config`
> handler builds `template_json` from scratch. It reads `existing_meta` from disk
> (line 276) but only explicitly preserves `pngUrl` and `fg_path`. The new
> `name_text` / `designation_text` fields MUST be preserved using the fallback
> `existing_meta.get(...)` pattern shown above, or they will be silently dropped
> when the Template Editor saves without sending text config fields.

**Important**: The key names in the JSON must be `name_text` and
`designation_text` (snake_case), exactly matching what `load_template_metadata()`
looks for in Phase 1.

The Pydantic field uses camelCase (`fontSize`) internally, but when serialised to
JSON via `.dict()` the keys are `fontSize`. The Phase 1 parser reads `fontSize`
with `raw.get("fontSize", 60)` — this is consistent.

#### 4. `GET /templates/{id}/config` — Already Exists (No Change Needed)

This endpoint already exists at admin.py line 339. It returns the raw JSON dict
stored on disk. The admin frontend can use it to pre-fill the editor with
existing settings, including `name_text` and `designation_text`.

```python
# Already exists — no change needed:
@router.get("/templates/{template_id}/config")
async def get_template_config(template_id: str):
    """Get full template configuration for the editor."""
    # ... existing implementation returns the raw JSON
```

---

## FG Upload — No Changes Needed

The existing `POST /templates/{id}/fg` endpoint (around line 441) already:
- Accepts any file extension via `os.path.splitext(file.filename or "fg.png")[1]`
- Saves as `{template_id}_fg{ext}` (so `.png` or `.svg` or anything)
- Writes the filename into `meta["fg_path"]` in the JSON

For magazine mode with PNG foregrounds, the admin simply uploads a PNG and the
endpoint stores it correctly. No changes required.

---

## Template JSON After Phase 4

After the admin saves via PUT, the full JSON will look like:

```json
{
  "templateId": "haleon-growth-story",
  "name": "Haleon Growth Story",
  "templateType": "magazine",
  "compositeMode": "magazine",
  "pngUrl": "haleon-growth-story.png",
  "png_path": "haleon-growth-story.png",
  "fg_path": "haleon-growth-story_fg.png",
  "anchorMode": "face_center",
  "stickerFilter": "none",
  "showVisualGuide": false,
  "allowManualPositioning": false,
  "dimensions": { "width": 1046, "height": 1440 },
  "slots": [ { "slotId": "main", "x": 0, "y": 0, "width": 1046, "height": 1440, ... } ],
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

---

## Test Checklist (manual)

1. `GET /api/admin/templates/{id}/config` — returns the full JSON dict.
2. `PUT /api/admin/templates/{id}/config` with `name_text: {"x":100,"y":200,"fontSize":50}`:
   - Verify the saved JSON file contains `"name_text": {"x":100,"y":200,...}`.
3. `PUT` without sending `name_text` — verify existing `name_text` in JSON is
   preserved (not overwritten with null).
4. `PUT` on a non-magazine template (no `name_text` in existing JSON) — verify no
   error and no `name_text` key is added to the JSON (it stays `{}`).
5. `POST /api/admin/templates/{id}/fg` with a PNG file — verify `fg_path` updated
   correctly. (Existing behaviour, just confirming it still works.)

---

## What This Phase Does NOT Do

- Does not build a frontend UI for text position config (that is a simple form
  in MagazineAdmin.tsx — can be added to Phase 7 or as a follow-up)
- Does not modify the photo generation pipeline (Phases 1–3)
- Does not touch the user-facing frontend wizard (Phases 5–7)
