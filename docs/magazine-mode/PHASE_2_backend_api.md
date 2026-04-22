# Phase 2 — Backend: generate.py Accepts name + designation

## Goal
Add two optional form fields — `magazine_name` and `magazine_designation` — to
the `POST /api/generate` endpoint, then thread these strings all the way through
to `compose_final()` so Phase 3 can draw them on the canvas.

**Only file changed: `backend/api/generate.py`**

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| `POST /api/generate` endpoint | ✅ exists, handles sticker / frame / pre_extracted |
| `fg_template_path` computed & passed to `compose_final` | ✅ lines 186-197 of generate.py |
| `compose_final()` signature | ✅ already has `fg_template_path` param |
| `magazine_name` / `magazine_designation` form fields | ❌ do not exist |
| `compose_final()` receiving name/designation | ❌ not yet wired |

---

## Changes Required

### File: `backend/api/generate.py`

#### 1. Add form params to the endpoint signature

The current signature (line 53-59):

```python
@router.post("/generate", response_model=GenerateResponse)
async def generate_composite(
    template_id: str = Form(...),
    photos: List[UploadFile] = File(...),
    slot_assignments: Optional[str] = Form(None),
    processing_mode: str = Form("sticker"),
    photo_position: Optional[str] = Form(None),
):
```

Change it to:

```python
@router.post("/generate", response_model=GenerateResponse)
async def generate_composite(
    template_id: str = Form(...),
    photos: List[UploadFile] = File(...),
    slot_assignments: Optional[str] = Form(None),
    processing_mode: str = Form("sticker"),
    photo_position: Optional[str] = Form(None),
    magazine_name: str = Form(""),           # NEW — person's name for magazine mode
    magazine_designation: str = Form(""),    # NEW — person's designation for magazine mode
):
```

Both fields are **optional with empty-string defaults** so all existing callers
(non-magazine templates) continue to work without sending these fields.

#### 2. Pass name + designation to `compose_final()`

Find the `compose_final()` call (currently around lines 190-197):

```python
final_image = compose_service.compose_final(
    template_path=template_path,
    stickers=processed_stickers,
    template_meta=template_meta,
    processing_mode=processing_mode,
    user_position=user_position,
    fg_template_path=fg_template_path,
)
```

Change it to:

```python
final_image = compose_service.compose_final(
    template_path=template_path,
    stickers=processed_stickers,
    template_meta=template_meta,
    processing_mode=processing_mode,
    user_position=user_position,
    fg_template_path=fg_template_path,
    magazine_name=magazine_name,            # NEW
    magazine_designation=magazine_designation,  # NEW
)
```

#### 3. No other changes needed in generate.py

The `fg_template_path` computation (lines 186-187) does not change:

```python
template_path = os.path.join(TEMPLATES_DIR, template_meta.png_path) if template_meta.png_path else None
fg_template_path = os.path.join(TEMPLATES_DIR, template_meta.fg_path) if template_meta.fg_path else None
```

This already correctly resolves the PNG path for magazine FG images.

---

## compose_final() Signature Update (stub for Phase 3)

**Phase 3** will add the actual drawing logic. In this phase, just add the two
new parameters to `compose_final()` in `backend/services/compose.py` so Python
does not throw a `TypeError` when the new call arrives:

```python
def compose_final(
    self,
    template_path: Optional[str],
    stickers: List[Dict],
    template_meta: TemplateMetadata,
    processing_mode: str = "sticker",
    user_position: Optional[Dict] = None,
    fg_template_path: Optional[str] = None,
    magazine_name: str = "",           # NEW — stub, used in Phase 3
    magazine_designation: str = "",    # NEW — stub, used in Phase 3
) -> Image.Image:
```

For now, these parameters are accepted but ignored. Phase 3 adds the drawing code.

---

## Verification

After this phase, run the server and POST to `/api/generate` with:

```
template_id=haleon-growth-story
photos=<some image>
processing_mode=sticker
magazine_name=Jane Smith
magazine_designation=Head of Marketing
```

The request must succeed (200 OK) and return a valid image URL. The name and
designation are not yet drawn on the image (that happens in Phase 3), but no
errors should occur.

Also verify the existing flow is unaffected:
- POST without `magazine_name` / `magazine_designation` → still works (empty string defaults)
- Frame mode templates → still work

---

## What This Phase Does NOT Do

- Does not draw name/designation text (Phase 3)
- Does not modify the admin endpoints (Phase 4)
- Does not touch the frontend (Phases 5–7)
- Does not change template JSON or schema (Phase 1)
