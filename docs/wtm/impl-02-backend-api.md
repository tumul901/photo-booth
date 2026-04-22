# IMPL-02 — Backend API: Composer + Guest Router + Admin Router
## Files to Create
- `backend/services/wtm_composer.py`
- `backend/api/wtm.py`
- `backend/api/wtm_admin.py`
- `tests/wtm/test_composer.py`

## Files to Modify
- `backend/main.py` — add WTM routers + startup (surgical, see below)

## Prerequisite
IMPL-01 complete. `backend/schemas/wtm_schemas.py`, `backend/services/wtm_config.py`,
`backend/services/wtm_cache.py`, and `backend/utils/wtm_utils.py` must all exist.

---

## Modify: backend/main.py

Add these imports at the top with the existing imports:
```python
from api.wtm import router as wtm_router
from api.wtm_admin import router as wtm_admin_router
```

Add WTM startup inside lifespan(), after `face_service.warm_up()`:
```python
from services.wtm_config import load_all_configs
from pathlib import Path
Path(settings.WTM_TEMPLATES_DIR).mkdir(parents=True, exist_ok=True)
Path(settings.WTM_CACHE_DIR).mkdir(parents=True, exist_ok=True)
load_all_configs()
```

Add after the existing `app.include_router(admin_router, ...)` line:
```python
app.include_router(wtm_router, prefix="/api/wtm", tags=["wtm"])
app.include_router(wtm_admin_router, prefix="/api/admin/wtm", tags=["wtm-admin"])
```

That is ALL that changes in main.py. Do not touch anything else.

---

## backend/services/wtm_composer.py — Implement Exactly

```python
import asyncio, time, logging, os
from pathlib import Path
from PIL import Image
from config import settings
from services.wtm_cache import wtm_cache
from services.wtm_config import WTM_TEMPLATES_DIR, WTM_CACHE_DIR
from utils.wtm_utils import rasterize_svg, compute_fit, make_cache_key
from schemas.wtm_schemas import ComposeResponse

logger = logging.getLogger(__name__)

SVG_RASTER_SCALE = int(os.environ.get('WTM_SVG_RASTER_SCALE', '3'))

_compose_locks: dict[str, asyncio.Lock] = {}
_locks_mutex = asyncio.Lock()


async def compose_template(config: dict, selected_words: list[str]) -> ComposeResponse:
    """
    Main entry point. selected_words already sorted by Pydantic validator
    but sort again defensively.
    """
    sorted_words = sorted(selected_words)
    cache_key = make_cache_key(config['template_id'], sorted_words)

    # Layer 1: LRU
    hit = wtm_cache.get(cache_key)
    if hit:
        return ComposeResponse(template_path=hit, cache_hit=True)

    # Layer 2: disk
    disk_path = WTM_CACHE_DIR / f'{cache_key}.png'
    if disk_path.exists():
        wtm_cache.put(cache_key, str(disk_path))
        return ComposeResponse(template_path=str(disk_path), cache_hit=True)

    # Acquire per-hash lock — prevents duplicate compositing on concurrent requests
    lock = await _get_or_create_lock(cache_key)
    async with lock:
        # DOUBLE-CHECK: another coroutine may have composed while we waited for the lock
        if disk_path.exists():
            wtm_cache.put(cache_key, str(disk_path))
            return ComposeResponse(template_path=str(disk_path), cache_hit=True)

        # Full compose in thread executor (CPU-bound, blocking)
        t0 = time.monotonic()
        try:
            output_path = await asyncio.wait_for(
                asyncio.get_event_loop().run_in_executor(
                    None, _sync_compose, config, sorted_words, disk_path
                ),
                timeout=5.0
            )
        except asyncio.TimeoutError:
            logger.error(f'WTM compose timeout: {config["template_id"]} words={sorted_words}')
            raise
        except Exception as e:
            logger.error(f'WTM compose failed: {config["template_id"]}: {e}')
            raise

        elapsed = int((time.monotonic() - t0) * 1000)
        wtm_cache.put(cache_key, str(output_path))
        logger.info(f'WTM composed in {elapsed}ms: {config["template_id"]}')
        return ComposeResponse(
            template_path=str(output_path),
            cache_hit=False,
            compose_time_ms=elapsed
        )


async def _get_or_create_lock(key: str) -> asyncio.Lock:
    async with _locks_mutex:
        if key not in _compose_locks:
            _compose_locks[key] = asyncio.Lock()
        return _compose_locks[key]


def _sync_compose(config: dict, sorted_words: list[str], output_path: Path) -> Path:
    """Blocking compose — runs in thread executor."""
    template_id = config['template_id']
    template_dir = WTM_TEMPLATES_DIR / template_id
    base_path = template_dir / config['base_image']

    base = Image.open(base_path).convert('RGBA')

    # Validate dimensions match config
    expected_w = config['dimensions']['width']
    expected_h = config['dimensions']['height']
    if base.width != expected_w or base.height != expected_h:
        raise ValueError(
            f'Base image size mismatch: config says {expected_w}x{expected_h}, '
            f'actual is {base.width}x{base.height}'
        )

    # Sort slots by order field
    slots = sorted(config['slots'], key=lambda s: s['order'])

    # Build word lookup
    word_map = {w['id']: w for w in config['words']}

    for i, word_id in enumerate(sorted_words):
        if i >= len(slots):
            logger.warning(f'More words than slots for {template_id}, stopping at {len(slots)}')
            break

        slot = slots[i]
        word_obj = word_map.get(word_id)
        if word_obj is None:
            logger.warning(f'Word {word_id} not in config for {template_id}, skipping slot {i}')
            continue

        svg_path = template_dir / 'words' / word_obj['svg_filename']
        if not svg_path.exists():
            logger.error(f'SVG missing: {svg_path}, skipping slot {i}')
            continue

        _paste_word_into_slot(base, svg_path, slot)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(str(output_path), 'PNG')
    return output_path


def _paste_word_into_slot(base: Image.Image, svg_path: Path, slot: dict) -> None:
    """Rasterize SVG at 3x, scale to fit slot, center, paste."""
    word_img = rasterize_svg(
        svg_path,
        target_width=slot['width'] * SVG_RASTER_SCALE,
        target_height=slot['height'] * SVG_RASTER_SCALE
    )
    if word_img is None:
        logger.error(f'Rasterization failed for {svg_path}, skipping slot')
        return

    fit_w, fit_h = compute_fit(word_img.width, word_img.height, slot['width'], slot['height'])
    word_img = word_img.resize((fit_w, fit_h), Image.LANCZOS)

    paste_x = slot['x'] + (slot['width'] - fit_w) // 2
    paste_y = slot['y'] + (slot['height'] - fit_h) // 2

    if word_img.mode == 'RGBA':
        base.paste(word_img, (paste_x, paste_y), word_img)
    else:
        base.paste(word_img.convert('RGBA'), (paste_x, paste_y))
```

---

## backend/api/wtm.py — Implement Exactly

```python
import asyncio
from fastapi import APIRouter, HTTPException
from schemas.wtm_schemas import (
    ComposeRequest, ComposeResponse, WordsResponse, WordItem, BundleItem
)
from services.wtm_config import get_config
from services.wtm_composer import compose_template

router = APIRouter(tags=['wtm'])


@router.get('/words/{template_id}', response_model=WordsResponse)
async def get_words(template_id: str):
    config = get_config(template_id)  # raises 400 if not found
    return WordsResponse(
        template_id=config['template_id'],
        words=[
            WordItem(
                id=w['id'],
                label=w['label'],
                svg_path=f"templates/wtm/{config['template_id']}/words/{w['svg_filename']}"
            )
            for w in config['words']
        ],
        bundles=[
            BundleItem(id=b['id'], label=b['label'], words=b['words'])
            for b in config.get('bundles', [])
        ],
        max_selections=config['max_selections'],
        slot_count=len(config['slots'])
    )


@router.post('/compose', response_model=ComposeResponse)
async def compose(req: ComposeRequest):
    config = get_config(req.template_id)

    valid_ids = {w['id'] for w in config['words']}
    invalid = [w for w in req.selected_words if w not in valid_ids]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail={
                'error_code': 'WORD_NOT_FOUND',
                'message': 'Unknown word IDs',
                'invalid_ids': invalid
            }
        )

    if len(req.selected_words) > len(config['slots']):
        raise HTTPException(
            status_code=400,
            detail={
                'error_code': 'SLOT_COUNT_MISMATCH',
                'message': (
                    f"Selected {len(req.selected_words)} words "
                    f"but template only has {len(config['slots'])} slots"
                )
            }
        )

    try:
        return await compose_template(config, req.selected_words)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=500,
            detail={'error_code': 'COMPOSE_FAILED', 'message': 'Compositing timed out'}
        )
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={'error_code': 'COMPOSE_FAILED', 'message': 'Compositing failed'}
        )
```

---

## backend/api/wtm_admin.py — Implement Exactly

```python
import json, shutil, re
from datetime import datetime, timezone
from pathlib import Path
from fastapi import APIRouter, HTTPException, File, UploadFile, Form
from fastapi.responses import FileResponse
from schemas.wtm_schemas import (
    SaveSlotsRequest, SaveBundlesRequest, WTMTemplateListItem
)
from services.wtm_config import (
    get_config, reload_config, WTM_TEMPLATES_DIR
)
from services.wtm_cache import wtm_cache
import services.compose as compose_service   # compose.py — for clear_template_cache()

router = APIRouter(tags=['wtm-admin'])

SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]+$')


def _safe_id(value: str) -> bool:
    return bool(SAFE_ID_RE.match(value))


def _load_raw_config(template_id: str) -> dict:
    config_path = WTM_TEMPLATES_DIR / template_id / 'config.json'
    if not config_path.exists():
        raise HTTPException(status_code=404, detail='WTM template not found')
    with open(config_path) as f:
        return json.load(f)


def _save_raw_config(template_id: str, config: dict) -> None:
    """Save config to disk, reload into memory, clear both caches."""
    config['updated_at'] = datetime.now(timezone.utc).isoformat()
    config_path = WTM_TEMPLATES_DIR / template_id / 'config.json'
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    reload_config(template_id)
    compose_service.clear_template_cache()  # match existing pattern from admin.py
    wtm_cache.clear()                       # clear WTM composed PNG cache


# ── Template CRUD ──────────────────────────────────────────────────────

@router.get('/templates', response_model=list[WTMTemplateListItem])
async def list_wtm_templates():
    items = []
    if not WTM_TEMPLATES_DIR.exists():
        return items
    for d in WTM_TEMPLATES_DIR.iterdir():
        if not d.is_dir():
            continue
        config_path = d / 'config.json'
        if not config_path.exists():
            continue
        try:
            with open(config_path) as f:
                c = json.load(f)
            items.append(WTMTemplateListItem(
                template_id=c['template_id'],
                name=c['name'],
                slot_count=len(c.get('slots', [])),
                word_count=len(c.get('words', [])),
                created_at=c.get('created_at', '')
            ))
        except Exception:
            continue
    return items


@router.post('/templates')
async def create_wtm_template(
    file: UploadFile = File(...),
    name: str = Form(...),
):
    """Create new WTM template. Upload base doodle PNG."""
    if file.content_type != 'image/png':
        raise HTTPException(
            status_code=400,
            detail={'error_code': 'INVALID_FILE', 'message': 'Base image must be PNG'}
        )

    # Generate safe template_id from name
    safe_id = re.sub(r'[^a-zA-Z0-9_-]', '_', name).lower().strip('_') or 'template'
    candidate = safe_id
    counter = 1
    while (WTM_TEMPLATES_DIR / candidate).exists():
        candidate = f'{safe_id}_{counter}'
        counter += 1
    template_id = candidate

    template_dir = WTM_TEMPLATES_DIR / template_id
    words_dir = template_dir / 'words'
    template_dir.mkdir(parents=True, exist_ok=True)
    words_dir.mkdir(exist_ok=True)

    content = await file.read()
    base_path = template_dir / 'base.png'
    with open(base_path, 'wb') as f:
        f.write(content)

    from PIL import Image
    with Image.open(base_path) as img:
        w, h = img.width, img.height

    now = datetime.now(timezone.utc).isoformat()
    config = {
        'template_id': template_id,
        'name': name,
        'mode': 'word_template',
        'base_image': 'base.png',
        'dimensions': {'width': w, 'height': h},
        'slots': [],
        'words': [],
        'bundles': [],
        'max_selections': 6,
        'created_at': now,
        'updated_at': now,
    }
    with open(template_dir / 'config.json', 'w') as f:
        json.dump(config, f, indent=2)

    reload_config(template_id)
    return {'template_id': template_id, 'name': name, 'dimensions': {'width': w, 'height': h}}


@router.delete('/templates/{template_id}')
async def delete_wtm_template(template_id: str):
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    template_dir = WTM_TEMPLATES_DIR / template_id
    if not template_dir.exists():
        raise HTTPException(status_code=404, detail='WTM template not found')
    shutil.rmtree(template_dir)
    compose_service.clear_template_cache()
    wtm_cache.clear()
    return {'success': True}


@router.get('/templates/{template_id}/config')
async def get_wtm_config(template_id: str):
    return _load_raw_config(template_id)


@router.get('/templates/{template_id}/image')
async def get_wtm_image(template_id: str):
    image_path = WTM_TEMPLATES_DIR / template_id / 'base.png'
    if not image_path.exists():
        raise HTTPException(status_code=404, detail='Base image not found')
    return FileResponse(str(image_path), media_type='image/png')


# ── Slot Management ────────────────────────────────────────────────────

@router.put('/templates/{template_id}/slots')
async def save_slots(template_id: str, req: SaveSlotsRequest):
    config = _load_raw_config(template_id)
    dims = config.get('dimensions', {})

    for slot in req.slots:
        if slot.x + slot.width > dims.get('width', 0):
            raise HTTPException(status_code=400, detail={
                'error_code': 'VALIDATION_ERROR',
                'message': f"Slot {slot.id}: x+width exceeds image width"
            })
        if slot.y + slot.height > dims.get('height', 0):
            raise HTTPException(status_code=400, detail={
                'error_code': 'VALIDATION_ERROR',
                'message': f"Slot {slot.id}: y+height exceeds image height"
            })

    orders = sorted([s.order for s in req.slots])
    if orders != list(range(len(req.slots))):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': f'Slot orders must be sequential with no gaps, got {orders}'
        })

    config['slots'] = [s.dict() for s in req.slots]
    _save_raw_config(template_id, config)
    return {'ok': True, 'slot_count': len(req.slots)}


# ── Word Management (atomic: word label + SVG together) ────────────────

@router.post('/templates/{template_id}/words')
async def add_word(
    template_id: str,
    label: str = Form(...),
    word_id: str = Form(...),
    file: UploadFile = File(...),
):
    """Add a word + its SVG atomically. word_id must match ^[a-z0-9-]+$"""
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    if not re.match(r'^[a-z0-9-]+$', word_id):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': 'word_id must be lowercase letters, numbers, and hyphens only'
        })
    if not (file.filename or '').endswith('.svg'):
        raise HTTPException(status_code=400, detail={
            'error_code': 'INVALID_FILE',
            'message': 'Word asset must be an SVG file (.svg extension)'
        })

    config = _load_raw_config(template_id)
    existing_ids = {w['id'] for w in config.get('words', [])}
    if word_id in existing_ids:
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': f"Word ID '{word_id}' already exists in this template"
        })

    # Save SVG file
    words_dir = WTM_TEMPLATES_DIR / template_id / 'words'
    words_dir.mkdir(exist_ok=True)
    svg_filename = f'{word_id}.svg'  # Always use word_id as filename — never raw upload name
    content = await file.read()
    with open(words_dir / svg_filename, 'wb') as f:
        f.write(content)

    config.setdefault('words', []).append({
        'id': word_id,
        'label': label,
        'svg_filename': svg_filename,
    })
    _save_raw_config(template_id, config)
    return {'ok': True, 'word_id': word_id, 'label': label}


@router.delete('/templates/{template_id}/words/{word_id}')
async def delete_word(template_id: str, word_id: str):
    config = _load_raw_config(template_id)
    config['words'] = [w for w in config.get('words', []) if w['id'] != word_id]
    # Remove from ALL bundles atomically
    for bundle in config.get('bundles', []):
        bundle['words'] = [wid for wid in bundle['words'] if wid != word_id]
    # Delete SVG file
    svg_path = WTM_TEMPLATES_DIR / template_id / 'words' / f'{word_id}.svg'
    if svg_path.exists():
        svg_path.unlink()
    _save_raw_config(template_id, config)
    return {'ok': True}


@router.get('/templates/{template_id}/words/{word_id}/svg')
async def get_word_svg(template_id: str, word_id: str):
    if not _safe_id(word_id):
        raise HTTPException(status_code=400, detail='Invalid word_id')
    svg_path = WTM_TEMPLATES_DIR / template_id / 'words' / f'{word_id}.svg'
    if not svg_path.exists():
        raise HTTPException(status_code=404, detail='SVG not found')
    return FileResponse(str(svg_path), media_type='image/svg+xml')


# ── Bundle Management ──────────────────────────────────────────────────

@router.put('/templates/{template_id}/bundles')
async def save_bundles(template_id: str, req: SaveBundlesRequest):
    config = _load_raw_config(template_id)
    valid_word_ids = {w['id'] for w in config.get('words', [])}
    for bundle in req.bundles:
        invalid = [wid for wid in bundle.words if wid not in valid_word_ids]
        if invalid:
            raise HTTPException(status_code=400, detail={
                'error_code': 'VALIDATION_ERROR',
                'message': f"Bundle '{bundle.id}' references unknown word IDs: {invalid}"
            })
    config['bundles'] = [b.dict() for b in req.bundles]
    _save_raw_config(template_id, config)
    return {'ok': True, 'bundle_count': len(req.bundles)}
```

---

## Required Tests — tests/wtm/test_composer.py

| Test | What to assert |
|------|---------------|
| `test_compose_cache_miss` | Compose valid template → disk PNG created, cache_hit=False |
| `test_compose_lru_hit` | Compose twice → second response has cache_hit=True |
| `test_compose_disk_hit_after_lru_clear` | Compose, clear LRU, compose again → cache_hit=True |
| `test_sorted_determinism` | Compose ["c","a","b"] and ["a","b","c"] → same template_path |
| `test_fewer_words_than_slots` | 3 words on 6-slot template → succeeds, returns PNG |
| `test_missing_svg_skips_slot` | Mock svg_path missing → compose succeeds, no exception |
| `test_timeout_raises` | Mock _sync_compose to sleep 6s → asyncio.TimeoutError |
| `test_concurrent_same_hash` | 5 concurrent identical composes → all same path, _sync_compose called once |
| `test_dimension_mismatch_raises` | base.png size != config dimensions → ValueError raised |
| `test_word_removed_from_bundles_on_delete` | Delete word → word removed from all bundles in config |
