# Magazine Mode — Complete Feature Plan

## 1. What Is Magazine Mode?

Magazine Mode is a new photobooth experience where the user is placed **inside a professionally designed magazine cover**. It is not an editor — it is a fixed, design-driven experience that produces a premium output instantly.

The experience is simple:
- User stands in front of the booth
- Takes a photo
- Gets placed inside a magazine cover
- Downloads / shares it

---

## 2. The Core Concept — 3-Layer Sandwich

The magazine cover is a **visual illusion** created by layering three things in order:

```
Layer 1 — Background (BG)
Layer 2 — User Cutout (person with bg removed)
Layer 3 — Foreground (FG)
```

### Layer 1 — Background (BG)
- A static image created by the designer
- Fills the entire canvas (full bleed)
- In the Haleon example: solid dark/black gradient image
- Stored as a PNG file

### Layer 2 — User Cutout
- The person's photo with background removed (rembg)
- Placed inside a defined **slot** with face-anchor positioning
- Sits between BG and FG — this is what creates the "inside the magazine" depth

### Layer 3 — Foreground (FG)
- The magazine design overlay
- Contains: title, article text, white border frame, QR code, bottom bar, date
- Provided by the designer as a **PNG file** (with transparency/alpha channel)
- Has **transparent areas** where the user and BG show through
- The white border frame sits **inside** the PNG canvas with intentional margins from the edges
- **NAME** and **DESIGNATION** are NOT in this PNG — they are drawn dynamically by Pillow after compositing

### After the Sandwich — Dynamic Text (Layer 4, conceptual)
- **NAME** and **DESIGNATION** are rendered by Pillow `ImageDraw.text()` directly on the composited canvas
- Drawn AFTER the FG layer, so they sit on top of everything (e.g., on the semi-transparent bottom bar)
- Position, font, size, and color are configured per-template in the JSON

### Why the margin in the FG is not a problem
The FG PNG has transparent pixels in the margin areas around the design elements. When composited over the BG, the BG shows through those transparent areas. The margin is preserved exactly as the designer intended, automatically.

### Alignment guarantee
Both BG and FG are passed through `_get_resized_template(path, canvas_w, canvas_h)` which forces both to the **exact same pixel dimensions**. Both are stamped at `(0, 0)` on the same canvas. Since they share the same coordinate space, pixel-perfect alignment is guaranteed with no manual offset math required.

---

## 3. The Real-Time Dynamic Elements

The only parts rendered dynamically (at photo generation time) are:

- **NAME** — the person's name (large text, bottom bar)
- **DESIGNATION** — their job title / role (smaller text, below name)

Everything else — HALEON title, article text, border frame, QR code, date — is baked into the designer's PNG assets and never changes per user.

### Why only these two?
- Keeps the system simple
- Designer retains full control of the visual quality
- No risk of user-generated content breaking the layout
- Fast generation — Pillow text drawing is near-instant

---

## 4. Assets — What the Designer Delivers

For each magazine template, the designer provides:

| Asset | Format | Description |
|-------|--------|-------------|
| Background | PNG | Full-bleed backdrop (scene, gradient, colour) |
| Foreground | PNG | Full overlay with all static design elements (transparent where user/BG show through) |

### Canvas Size Rule (Critical)
Both BG and FG **must be built at the same canvas dimensions**. The template JSON stores `dimensions: { width: 1046, height: 1440 }` — this is the source of truth for the entire pipeline.

### PNG Requirements for the Designer
- FG PNG must have a transparent background (alpha channel preserved)
- All static text (titles, articles, dates) should be baked into the PNG
- NAME and DESIGNATION text areas should be left **empty** in the PNG — the backend draws them dynamically using Pillow
- The designer provides the exact pixel coordinates where NAME and DESIGNATION should appear (documented in the template JSON)

---

## 5. Technical Pipeline

### 5.1 At Template Setup Time (Admin)
1. Admin uploads BG PNG → stored as `{template_id}_bg.png`
2. Admin uploads FG PNG → stored as `{template_id}_fg.png`
3. Admin draws the **person slot** on the BG image using the visual editor
4. Admin sets face anchor point within the slot
5. Admin configures: `desiredFaceRatio`, `minZoom`, `maxZoom`, `anchorMode`
6. Admin configures text positions: `name_text` and `designation_text` (x, y, fontSize, color, etc.)
7. Config saved to `{template_id}.json` with `compositeMode: "magazine"`

### 5.2 At Photo Generation Time (User)
```
Input: photo + name + designation + template_id

Step 1 — Remove background (rembg)
         → user cutout PNG (transparent)

Step 2 — Crop to alpha bounding box
         → tight crop around person

Step 3 — Face detection (face_service)
         → landmarks: center_x, center_y, eye_y, face_height

Step 4 — Load BG PNG
         → resize to canvas_w × canvas_h

Step 5 — Load FG PNG
         → resize to canvas_w × canvas_h

Step 6 — Compose (compose_final, compositeMode="magazine")
         a. canvas = blank RGBA at canvas_w × canvas_h
         b. alpha_composite(canvas, BG)          ← Layer 1
         c. paste(user_cutout, position)          ← Layer 2 (face-anchored)
         d. alpha_composite(canvas, FG)           ← Layer 3

Step 7 — Draw NAME text using Pillow ImageDraw
         → position, font, size, color from template JSON (name_text config)

Step 8 — Draw DESIGNATION text using Pillow ImageDraw
         → position, font, size, color from template JSON (designation_text config)

Step 9 — Encode → JPEG/PNG → save → return URL
```

### 5.3 Text Drawing with Pillow (Detail)
After the 3-layer sandwich is composited, NAME and DESIGNATION are drawn directly
onto the canvas using Pillow's `ImageDraw.text()`. The position, font, size, and
color come from `MagazineTextConfig` stored in the template JSON.

```python
from PIL import ImageDraw, ImageFont

def draw_magazine_text(canvas, text, cfg, res_multiplier):
    """Draw a single text element on the final composited canvas."""
    if not text or not text.strip():
        return

    display_text = text.upper() if cfg.uppercase else text
    x = int(cfg.x * res_multiplier)
    y = int(cfg.y * res_multiplier)
    font_size = int(cfg.font_size * res_multiplier)

    font = ImageFont.truetype(cfg.font_path, font_size) if cfg.font_path else ImageFont.load_default()

    draw = ImageDraw.Draw(canvas)
    draw.text((x, y), display_text, font=font, fill=cfg.color)
```

No SVG processing, no cairosvg dependency. Text coordinates are stored in the
template JSON and scaled by `res_multiplier` at render time.

---

## 6. New API Changes

### 6.1 Backend — compose.py
- `TemplateMetadata` gets `fg_path: str = ""` field ✅ (done)
- `compose_final` gets `fg_template_path` param ✅ (done)
- `compositeMode = "magazine"`:
  - BG placed behind user ✅ (done)
  - FG placed on top of user ✅ (done)
- **TODO**: Add `MagazineTextConfig` dataclass and `name_text` / `designation_text` fields to `TemplateMetadata` (Phase 1)
- **TODO**: Add `_draw_magazine_text()` method to draw NAME/DESIGNATION via Pillow after FG overlay (Phase 3)

### 6.2 Backend — admin.py
- `POST /api/admin/templates` handles `mode=magazine` ✅ (done)
- `POST /api/admin/templates/{id}/fg` — upload FG image ✅ (done)
- `GET /api/admin/templates/{id}/fg-image` — serve FG ✅ (done)
- `GET /api/admin/templates/{id}/config` — return template JSON ✅ (already exists)
- **TODO**: Extend `TemplateConfigUpdate` with `name_text` / `designation_text` optional fields (Phase 4)
- **TODO**: Persist text config in `PUT /templates/{id}/config` (Phase 4)

### 6.3 Backend — generate.py
- `fg_template_path` computed and passed to `compose_final` ✅ (done)
- **TODO**: Accept `magazine_name` and `magazine_designation` form fields (Phase 2)
- **TODO**: Pass them through to `compose_final()` for Pillow text drawing (Phase 2)

### 6.4 Dependencies
No new Python dependencies needed. Pillow (`ImageDraw`, `ImageFont`) is already
available. The `cairosvg` and `cairocffi` entries in `requirements.txt` are
leftover from the original SVG plan and can be removed.

---

## 7. Frontend — User Flow

The photobooth flow for a magazine template gets one extra step:

```
Start
  → Choose Template (magazine template selected)
  → Enter Name + Designation          ← NEW STEP (only for magazine mode)
  → Capture Photo
  → (Optional) Adjust Position
  → Final Magazine Cover
  → Download / Share
```

### Name + Designation Input Screen
- Clean, minimal form
- Two fields: Name, Designation
- Both required before proceeding
- Pre-filled defaults optional (e.g. from QR scan / event registration)
- These values are passed to `/api/generate` alongside the photo

---

## 8. Frontend — Admin Panel

A dedicated **📰 Magazine** tab in the admin panel. Built as `MagazineAdmin.tsx`. ✅ (done)

### Capabilities
1. **Create magazine template**
   - Enter name
   - Upload BG image
   - Template created with `compositeMode: "magazine"`

2. **Upload Foreground PNG**
   - Per-template FG upload card
   - Status badge: ✅ BG + FG ready / ⚠️ FG missing
   - Preview stacks BG + FG so composite is visible at a glance

3. **Configure Slot** (opens TemplateEditor)
   - Draw the person rectangle on the BG image
   - Set face anchor point (where the face should land in the slot)
   - FG overlay toggle (60% opacity) so designer sees exactly where slot sits relative to FG elements
   - Settings: `desiredFaceRatio`, `minZoom`, `maxZoom`, `anchorMode`

4. **Configure Text Positions**
   - Set x, y, fontSize, color, fontPath, maxWidth, align, uppercase for NAME
   - Set same for DESIGNATION
   - These get saved into `name_text` / `designation_text` in the template JSON

5. **Delete template**

### TemplateEditor — Magazine Extensions ✅ (done)
- `compositeMode: 'magazine'` option in dropdown
- Loads FG image from `/api/admin/templates/{id}/fg-image` when compositeMode is magazine
- FG drawn as 60%-opacity overlay on canvas
- Toolbar toggle: **FG: ON / OFF**

---

## 9. Template JSON Structure

```json
{
  "templateId": "haleon-growth-story",
  "name": "Haleon Growth Story",
  "templateType": "magazine",
  "compositeMode": "magazine",
  "png_path": "haleon-growth-story_bg.png",
  "fg_path": "haleon-growth-story_fg.png",
  "anchorMode": "face_center",
  "dimensions": {
    "width": 1046,
    "height": 1440
  },
  "slots": [
    {
      "slotId": "main",
      "x": 0,
      "y": 0,
      "width": 1046,
      "height": 1440,
      "anchor": {
        "targetX": 680,
        "targetY": 320
      },
      "desiredFaceRatio": 0.22,
      "minZoom": 0.8,
      "maxZoom": 2.0,
      "zIndex": 0
    }
  ],
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

## 10. What Is Already Built vs What Is Pending

### ✅ Already Built
- `compositeMode: "magazine"` in compose pipeline (BG → user → FG)
- `fg_path` field on `TemplateMetadata`
- `fg_template_path` passed through generate pipeline
- Admin endpoints: FG upload, FG image serve, config GET
- `MagazineAdmin.tsx` — full magazine admin panel
- `TemplateEditor.tsx` — FG overlay toggle for magazine mode
- Magazine tab in admin page

### 🔲 Still To Build
1. **MagazineTextConfig schema** — add dataclass to `compose.py`, parse from template JSON (Phase 1)
2. **API form fields** — accept `magazine_name` / `magazine_designation` in `/api/generate` (Phase 2)
3. **Pillow text drawing** — `_draw_magazine_text()` method in `ComposeService` (Phase 3)
4. **Admin text config** — persist `name_text` / `designation_text` via PUT config endpoint (Phase 4)
5. **Frontend template detection** — expose `compositeMode` from API, store in page state (Phase 5)
6. **Name + Designation input** — new `MagazineNameScreen` component (Phase 6)
7. **Wizard integration** — wire name screen into wizard flow, send to API (Phase 7)

---

## 11. Key Design Decisions (Locked)

| Decision | Choice | Reason |
|----------|--------|--------|
| Customisation level | Minimal — name + designation only | Keeps experience fast and premium |
| FG format | PNG (designer asset, with transparency) | Simple, no SVG rendering issues, designer has full control |
| Text rendering method | Pillow `ImageDraw.text()` after FG composite | No new dependencies, coordinates stored in template JSON |
| Dependencies | None new — Pillow already available | No cairosvg, no SVG font issues |
| Alignment method | Both BG and FG forced to same canvas_w × canvas_h | Guaranteed pixel-perfect alignment, no offset math |
| Margin preservation | Automatic — FG transparent areas show BG | No special handling needed |
| Person placement | Face-anchor with desiredFaceRatio | Consistent framing across all users |
| Admin workflow | Separate Magazine tab | Clean separation from regular sticker/frame templates |

---

## 12. Haleon Template — Specific Notes

Based on the master design shared:

- **Canvas size**: `1046 × 1440`
- **FG PNG elements**: HALEON title (lime green), GROWTH STORY, TIME IN FOCUS, DIVING DEEPER, MUST READ / BUSINESS OF SMILES, white border frame, semi-transparent bottom bar (opacity 0.63), QR code, date — all baked into the PNG
- **Dynamic fields**: `NAME` (large Bebas Neue, drawn by Pillow on the bottom bar area), `DESIGNATION` (smaller, below name)
- **Person placement**: Right-center of canvas, head breaking above the white border top line (creates depth illusion)
- **Font**: Bebas Neue Bold (needs to be installed on the server or bundled as a .ttf file for Pillow to use)
- **Bottom bar**: Located around y=1192, 818×200px, at 63% opacity — NAME text is drawn ON TOP of this bar after FG compositing

---

## 13. Font Handling Note

Pillow's `ImageFont.truetype()` requires a `.ttf` file path. For the Haleon template:

- Bundle `BebasNeue-Bold.ttf` in the Docker image (e.g. at `/app/fonts/BebasNeue-Bold.ttf`)
- Set `"fontPath": "/app/fonts/BebasNeue-Bold.ttf"` in the template JSON's `name_text` and `designation_text` configs
- Fallback chain: custom TTF → system fonts (DejaVu, Liberation, Arial) → Pillow default bitmap font

No SVG font embedding needed — all static text is already baked into the FG PNG by the designer.
