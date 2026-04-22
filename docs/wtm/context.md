# WTM CONTEXT — READ THIS FIRST, EVERY SESSION

## What You Are Building
Word Template Mode (WTM) is a new feature added to an existing Photo Booth SaaS. It adds:
1. A third mode option (alongside Frame and Sticker) in the guest wizard
2. A new admin section for setting up word templates before events
3. A backend compositing engine that pastes word SVGs into a doodle template PNG
4. A new word selection step in the guest wizard (step 3, between Template and Capture)

## The Complete Compositing Chain
```
Base doodle PNG (uploaded by admin)
+ Word SVGs pasted into predefined slots    <- WTM composer produces this
= Final template PNG
+ User photo (background removed)           <- EXISTING pipeline handles this, unchanged
= Final photo output
```
The existing pipeline receives a template path pointing to a PNG.
After WTM, it sometimes receives a WTM-generated PNG instead of a static one.
Format, dimensions, and file type are identical. Nothing downstream changes.

## Existing Project Structure (REFERENCE — do not invent paths)
```
photo-booth/
├── backend/
│   ├── api/
│   │   ├── admin.py          <- DO NOT TOUCH
│   │   └── generate.py       <- DO NOT TOUCH
│   ├── services/
│   │   ├── compose.py        <- DO NOT TOUCH. Has clear_template_cache(). Call after WTM saves.
│   │   ├── face_service.py   <- DO NOT TOUCH
│   │   ├── rembg_service.py  <- DO NOT TOUCH
│   │   ├── social_wall_service.py <- DO NOT TOUCH
│   │   ├── stats_service.py  <- DO NOT TOUCH
│   │   └── storage_service.py <- DO NOT TOUCH. USE but do not modify.
│   ├── models/               <- AI/ML model files ONLY. DO NOT PUT CODE HERE.
│   ├── data/                 <- DO NOT TOUCH
│   ├── config.py             <- MODIFY: add 2 WTM path settings only
│   ├── main.py               <- MODIFY: add WTM routers + startup only
│   └── requirements.txt      <- MODIFY: add cairosvg, cairocffi
│
├── frontend/
│   ├── app/
│   │   └── admin/
│   │       └── page.tsx      <- MODIFY: add 4th tab only
│   ├── components/
│   │   ├── screens/
│   │   │   ├── StartScreen.tsx     <- MODIFY: add word_template mode card
│   │   │   ├── TemplateScreen.tsx  <- MODIFY: add word_template to type only
│   │   │   ├── CaptureScreen.tsx   <- DO NOT TOUCH
│   │   │   ├── PreviewEditScreen.tsx <- DO NOT TOUCH
│   │   │   ├── PreviewScreen.tsx   <- DO NOT TOUCH
│   │   │   └── ResultScreen.tsx    <- DO NOT TOUCH
│   │   ├── TemplateEditor.tsx      <- DO NOT TOUCH
│   │   ├── TemplateSelector.tsx    <- MODIFY: add word_template support
│   │   ├── StepIndicator.tsx       <- MODIFY: make steps dynamic for 5-step flow
│   │   └── index.ts                <- MODIFY: add WTM component exports
│   └── app/page.tsx          <- MODIFY: add WTM step + state
│
└── templates/                <- Existing overlay files. DO NOT TOUCH existing files.
```

## New Files to Create
```
backend/
  api/
    wtm.py                    <- guest compose endpoints
    wtm_admin.py              <- admin WTM endpoints
  services/
    wtm_composer.py           <- compositing engine
    wtm_cache.py              <- LRU + disk cache
    wtm_config.py             <- config loader + validator
  schemas/                    <- NEW DIRECTORY (Pydantic models — NOT backend/models/)
    wtm_schemas.py
  utils/                      <- NEW DIRECTORY
    wtm_utils.py

frontend/
  components/
    WTMAdmin.tsx + .module.css
    WTMSlotEditor.tsx + .module.css
    WTMWordManager.tsx + .module.css
    WTMBundleManager.tsx + .module.css
    WordSelectionStep.tsx + .module.css
    WordGrid.tsx + .module.css
    WordTile.tsx + .module.css
    BundleRow.tsx + .module.css
    SelectionCounter.tsx + .module.css
  hooks/                      <- NEW DIRECTORY
    useWordSelection.ts
  api/                        <- NEW DIRECTORY
    wtm.ts
  types/                      <- NEW DIRECTORY
    wtm.ts

tests/                        <- NEW DIRECTORY (at project root level)
  wtm/
    __init__.py
    test_composer.py
    test_cache.py
    test_config.py

templates/
  wtm/                        <- NEW DIRECTORY, auto-managed
    {template_id}/
      config.json
      base.png
      words/
        {word_id}.svg
  wtm_cache/                  <- NEW DIRECTORY, auto-created at runtime, gitignored
    {sha256_hash}.png
```

## Existing Patterns — Follow These Exactly

### Backend import pattern (from main.py)
```python
from api.generate import router as generate_router   # existing
from api.wtm import router as wtm_router             # new — same pattern
from config import settings                          # existing
```

### Router registration pattern (from main.py)
```python
app.include_router(generate_router, prefix="/api", tags=["generate"])   # existing
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])   # existing
app.include_router(wtm_router, prefix="/api/wtm", tags=["wtm"])        # new
app.include_router(wtm_admin_router, prefix="/api/admin/wtm", tags=["wtm-admin"])  # new
```

### Lifespan pattern (from main.py) — WTM startup goes inside here
```python
@asynccontextmanager
async def lifespan(app: FastAPI):
    # existing warmups...
    rembg_service.warm_up()
    face_service.warm_up()
    # ADD WTM startup here:
    from services.wtm_config import load_all_configs
    from pathlib import Path
    from config import settings
    Path(settings.WTM_TEMPLATES_DIR).mkdir(parents=True, exist_ok=True)
    Path(settings.WTM_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    load_all_configs()
    yield
    stats_service.flush()
```

### Config pattern (from config.py) — add inside Settings class
```python
WTM_TEMPLATES_DIR: str = "templates/wtm"
WTM_CACHE_DIR: str = "templates/wtm_cache"
```

### Path resolution in WTM services — use settings, not hardcoded paths
```python
from config import settings
from pathlib import Path
WTM_TEMPLATES_DIR = Path(settings.WTM_TEMPLATES_DIR)
WTM_CACHE_DIR = Path(settings.WTM_CACHE_DIR)
```

### Cache clearing pattern (from admin.py)
```python
import services.compose as compose_service   # existing module name is compose.py
compose_service.clear_template_cache()       # call this after every WTM save/delete
```

### Frontend API_BASE_URL pattern
```typescript
const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';
```

### sessionStorage state pattern (from page.tsx)
```typescript
const [selectedWords, setSelectedWords] = useSessionState<string[]>('selectedWords', []);
const [composedTemplatePath, setComposedTemplatePath] = useSessionState<string | null>('composedTemplatePath', null);
```

### CSS Modules pattern — every component needs a .module.css file
Every new .tsx component must have a matching .module.css file. Even if minimal.

### Component barrel export pattern (from index.ts)
```typescript
export { default as WTMAdmin } from './WTMAdmin';
```

## Updated Wizard Flow

### Current flow (frame/sticker — UNCHANGED)
```
Step 1: StartScreen (mode selection)
Step 2: TemplateScreen (template selection)
Step 3: CaptureScreen (photo capture)
Step 4: ResultScreen
```

### New flow when processingMode === 'word_template'
```
Step 1: StartScreen (mode selection) — adds Word Template card
Step 2: TemplateScreen (WTM template selection)
Step 3: WordSelectionStep (NEW — word selection + compose)
Step 4: CaptureScreen (photo capture — unchanged)
Step 5: ResultScreen (unchanged)
```

### Step number rules in page.tsx
- frame/sticker: steps 1→2→3→4 (unchanged)
- word_template: steps 1→2→3→4→5
- StepIndicator receives processingMode prop and shows 4 or 5 steps accordingly
- handleTemplateNext: always goes to step 3 (same for all modes)
- Word selection step only rendered when step===3 AND processingMode==='word_template'
- CaptureScreen renders at step===3 (frame/sticker) OR step===4 (word_template)
- ResultScreen renders at step===4 (frame/sticker) OR step===5 (word_template)

### executeGeneration change for word_template
```typescript
// When processingMode === 'word_template', use composedTemplatePath as template_id
// The composedTemplatePath is an absolute path to the composed PNG
// Pass it as template_path in the FormData instead of template_id
// Check with generate.py what field it expects — do not change generate.py
formData.append('template_id', selectedTemplate);  // existing (frame/sticker)
// For word_template: the composed PNG path becomes the template
// Append composedTemplatePath so the backend uses the WTM-generated PNG
```

## API Surface (complete)

### Guest endpoints (prefix: /api/wtm)
```
GET  /api/wtm/words/{template_id}   -> WordsResponse
POST /api/wtm/compose               -> ComposeResponse
```

### Admin endpoints (prefix: /api/admin/wtm)
```
GET    /api/admin/wtm/templates
POST   /api/admin/wtm/templates
DELETE /api/admin/wtm/templates/{template_id}
GET    /api/admin/wtm/templates/{template_id}/config
PUT    /api/admin/wtm/templates/{template_id}/slots
GET    /api/admin/wtm/templates/{template_id}/image
POST   /api/admin/wtm/templates/{template_id}/words
DELETE /api/admin/wtm/templates/{template_id}/words/{word_id}
GET    /api/admin/wtm/templates/{template_id}/words/{word_id}/svg
PUT    /api/admin/wtm/templates/{template_id}/bundles
```

## Architectural Decisions — NON-NEGOTIABLE
| # | Decision |
|---|----------|
| 1 | SVG for all word assets. Never PNG or font-rendered text. |
| 2 | Backend compositing only. No browser canvas rendering of final template. |
| 3 | Existing pipeline untouched. WTM output is a PNG path, nothing in generate.py changes. |
| 4 | Hash-based caching. SHA-256(template_id + "|" + sorted_words.join(",")). |
| 5 | Words sorted alphabetically server-side before hashing. Always. |
| 6 | Slots filled by slot.order ascending. Alphabetically-first word → slot 0. |
| 7 | Max 6 words enforced in TWO places: frontend UI and backend Pydantic validator. |
| 8 | Word+SVG added atomically. No word without an SVG. No SVG without a word entry. |
| 9 | New template per event. No runtime word changes during live events. |
| 10 | compose_service.clear_template_cache() called after every WTM config save/delete. |
| 11 | WTM admin is a 4th tab in admin page.tsx. Existing tabs and TemplateEditor untouched. |
| 12 | WTM endpoints in wtm.py and wtm_admin.py. Never added to admin.py or generate.py. |
| 13 | Pydantic models go in backend/schemas/wtm_schemas.py. Never in backend/models/. |
| 14 | Path constants come from config.py settings. Never hardcoded in service files. |
| 15 | Every new frontend component has a matching .module.css file. |

## Cache Architecture
Two-layer cache:
- Layer 1 — In-memory LRU: 200 entries. Keyed by SHA-256 hash. Zero disk I/O on hit.
- Layer 2 — Disk: settings.WTM_CACHE_DIR/{hash}.png. Survives restarts.

Lookup order:
1. LRU hit → return immediately
2. Disk hit → load into LRU → return
3. Miss → acquire per-hash async lock → double-check disk → compose → save → LRU → return

Cache key:
```python
sorted_words = sorted(selected_words)  # ALWAYS sort first
key_str = f"{template_id}|{','.join(sorted_words)}"
cache_key = hashlib.sha256(key_str.encode('utf-8')).hexdigest()
```

Double-check pattern inside lock is MANDATORY. Do not simplify it away.

## Edge Cases
| Edge Case | Where Handled | Behaviour |
|-----------|--------------|-----------|
| Fewer words than slots | Backend composer | Allowed. Empty slots left transparent. |
| Word SVG missing from disk | Backend composer | Log error, skip slot silently. Do not abort. |
| Slot bounding box outside image dims | Config loader at startup | Reject entire config. Log. |
| Concurrent requests with same hash | Cache layer | Per-hash async lock + double-check. |
| WTM dirs missing at startup | lifespan() in main.py | Auto-created via mkdir. |
| selected_words has duplicates | Pydantic validator | Deduplicate silently. |
| template_id not found | Backend router | 400 INVALID_TEMPLATE immediately. |
| Compose exceeds 5 seconds | asyncio.wait_for timeout=5.0 | 500 COMPOSE_FAILED. |
| SVG rasterization returns empty | Backend composer | Skip slot, log error. |
| Admin deletes word in a bundle | wtm_admin.py | Remove word from all bundles atomically. |
| Admin saves 0 slots | Config validation | Reject. Minimum 1 slot required. |
| Admin uploads non-PNG base image | wtm_admin.py | Reject 400. PNG only. |
| Admin uploads non-SVG word file | wtm_admin.py | Reject 400. SVG only. |

## Security
- WTM admin endpoints require existing admin auth middleware.
- template_id and word_id validated against ^[a-zA-Z0-9_-]+$ before any filesystem op.
- Cache paths built with Path(settings.WTM_CACHE_DIR) / filename. Never raw user input.
- SVG filenames sanitised: {word_id}.svg only. Never use uploaded filename directly.

## Performance Targets
| Operation | Target p95 | Hard Limit |
|-----------|-----------|------------|
| Compose — LRU hit | < 20ms | < 50ms |
| Compose — disk hit | < 100ms | < 200ms |
| Compose — full miss | < 1500ms | < 5000ms |
| GET /api/wtm/words | < 50ms | < 150ms |

## Out of Scope — DO NOT IMPLEMENT
- Cache warm-up tool
- Per-slot font or color overrides
- Animated or video templates
- Word list editing during a live event
- Any changes to generate.py
- Any changes to admin.py
- Any changes to compose.py (only call clear_template_cache from it)
- Any changes to CaptureScreen, PreviewEditScreen, PreviewScreen, ResultScreen
- Any changes to TemplateEditor.tsx
