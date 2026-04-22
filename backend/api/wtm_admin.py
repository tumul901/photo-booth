import json, shutil, re, logging
from datetime import datetime, timezone
from fastapi import APIRouter, HTTPException, File, UploadFile, Form

logger = logging.getLogger(__name__)
from fastapi.responses import FileResponse
from schemas.wtm_schemas import (
    SaveSlotsRequest, SaveBundlesRequest, WTMTemplateListItem,
    SavePhotoSlotRequest, SaveSettingsRequest,
    SaveTextOverlayRequest,
)
from services import wtm_config
from services.wtm_cache import wtm_cache
import services.compose as compose_service   # compose.py — for clear_template_cache()

router = APIRouter(tags=['wtm-admin'])

SAFE_ID_RE = re.compile(r'^[a-zA-Z0-9_-]+$')


def _safe_id(value: str) -> bool:
    return bool(SAFE_ID_RE.match(value))


def _load_raw_config(template_id: str) -> dict:
    config_path = wtm_config.WTM_TEMPLATES_DIR / template_id / 'config.json'
    if not config_path.exists():
        raise HTTPException(status_code=404, detail='WTM template not found')
    with open(config_path) as f:
        return json.load(f)


def _save_raw_config(template_id: str, config: dict) -> None:
    """Save config to disk, reload into memory, clear both caches."""
    config['updated_at'] = datetime.now(timezone.utc).isoformat()
    config_path = wtm_config.WTM_TEMPLATES_DIR / template_id / 'config.json'
    print(f"SAVING TO: {config_path.absolute()}", flush=True)
    with open(config_path, 'w') as f:
        json.dump(config, f, indent=2)
    print(f"FILE EXISTS AFTER WRITE: {config_path.exists()}", flush=True)
    wtm_config.reload_config(template_id)
    compose_service.clear_template_cache()  # match existing pattern from admin.py
    wtm_cache.clear()                       # clear WTM composed PNG cache


# ── Template CRUD ──────────────────────────────────────────────────────

@router.get('/templates', response_model=list[WTMTemplateListItem])
async def list_wtm_templates():
    items = []
    if not wtm_config.WTM_TEMPLATES_DIR.exists():
        return items
    for d in wtm_config.WTM_TEMPLATES_DIR.iterdir():
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
    while (wtm_config.WTM_TEMPLATES_DIR / candidate).exists():
        candidate = f'{safe_id}_{counter}'
        counter += 1
    template_id = candidate

    template_dir = wtm_config.WTM_TEMPLATES_DIR / template_id
    words_dir = template_dir / 'words'
    template_dir.mkdir(parents=True, exist_ok=True)
    words_dir.mkdir(exist_ok=True)

    content = await file.read()
    base_path = template_dir / 'base.png'
    with open(base_path, 'wb') as f:
        f.write(content)

    from PIL import Image

    # Resize oversized images at upload time — images >3000px on the longest edge
    # take too long to composite and will always time out the compose step.
    MAX_DIMENSION = 3000
    Image.MAX_IMAGE_PIXELS = None  # admin upload — trusted source, skip bomb check
    with Image.open(base_path) as img:
        original_w, original_h = img.width, img.height
        if original_w > MAX_DIMENSION or original_h > MAX_DIMENSION:
            # Compute new size preserving aspect ratio
            scale = MAX_DIMENSION / max(original_w, original_h)
            new_w = max(1, int(original_w * scale))
            new_h = max(1, int(original_h * scale))
            resized = img.convert('RGBA').resize((new_w, new_h), Image.LANCZOS)
            resized.save(str(base_path), 'PNG')
            w, h = new_w, new_h
            logger.info(
                f'WTM base image resized from {original_w}x{original_h} '
                f'to {w}x{h} for template {template_id}'
            )
        else:
            w, h = original_w, original_h
    Image.MAX_IMAGE_PIXELS = 178956970  # restore default after read

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
        'allow_manual_positioning': True,
        'created_at': now,
        'updated_at': now,
    }
    with open(template_dir / 'config.json', 'w') as f:
        json.dump(config, f, indent=2)

    wtm_config.reload_config(template_id)
    return {'template_id': template_id, 'name': name, 'dimensions': {'width': w, 'height': h}}


@router.delete('/templates/{template_id}')
async def delete_wtm_template(template_id: str):
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    template_dir = wtm_config.WTM_TEMPLATES_DIR / template_id
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
    image_path = wtm_config.WTM_TEMPLATES_DIR / template_id / 'base.png'
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


@router.put('/templates/{template_id}/photo-slot')
async def save_photo_slot(template_id: str, req: SavePhotoSlotRequest):
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    config = _load_raw_config(template_id)
    dims = config.get('dimensions', {})
    ps = req.photo_slot
    if ps.x + ps.width > dims.get('width', 0):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': 'photo_slot: x+width exceeds image width'
        })
    if ps.y + ps.height > dims.get('height', 0):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': 'photo_slot: y+height exceeds image height'
        })
    config['photo_slot'] = ps.dict()
    _save_raw_config(template_id, config)
    return {'ok': True}


@router.put('/templates/{template_id}/settings')
async def save_settings(template_id: str, req: SaveSettingsRequest):
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    config = _load_raw_config(template_id)
    config['allow_manual_positioning'] = req.allow_manual_positioning
    config['max_selections'] = req.max_selections
    _save_raw_config(template_id, config)
    return {'ok': True}


# ── Font discovery ─────────────────────────────────────────────────────

@router.get('/fonts')
async def list_fonts():
    from utils.wtm_utils import list_available_fonts
    return {'fonts': list_available_fonts()}


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
    filename_lower = (file.filename or '').lower()
    if not (filename_lower.endswith('.svg') or filename_lower.endswith('.png')):
        raise HTTPException(status_code=400, detail={
            'error_code': 'INVALID_FILE',
            'message': 'Word asset must be an SVG or PNG file'
        })

    config = _load_raw_config(template_id)
    existing_ids = {w['id'] for w in config.get('words', [])}
    if word_id in existing_ids:
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': f"Word ID '{word_id}' already exists in this template"
        })

    ext = '.png' if filename_lower.endswith('.png') else '.svg'
    asset_filename = f'{word_id}{ext}'
    words_dir = wtm_config.WTM_TEMPLATES_DIR / template_id / 'words'
    words_dir.mkdir(exist_ok=True)
    content = await file.read()
    with open(words_dir / asset_filename, 'wb') as f:
        f.write(content)

    config.setdefault('words', []).append({
        'id': word_id,
        'label': label,
        'svg_filename': asset_filename,
    })
    _save_raw_config(template_id, config)
    return {'ok': True, 'word_id': word_id, 'label': label}


@router.post('/templates/{template_id}/words/text')
async def add_text_word(
    template_id: str,
    word_id: str = Form(...),
    label: str = Form(...),
    text: str = Form(...),
    font: str = Form(...),
    color: str = Form('#000000'),
    align: str = Form('center'),
):
    """Add a text-rendered word (no file upload — rendered at compose time)."""
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    if not re.match(r'^[a-z0-9-]+$', word_id):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': 'word_id must be lowercase letters, numbers, and hyphens only'
        })
    if align not in ('left', 'center', 'right'):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': "align must be 'left', 'center', or 'right'"
        })
    # Verify font exists on disk
    from utils.wtm_utils import find_font_path
    if find_font_path(font) is None:
        raise HTTPException(status_code=400, detail={
            'error_code': 'INVALID_FONT',
            'message': f"Font '{font}' not found in backend/fonts/"
        })

    config = _load_raw_config(template_id)
    if any(w['id'] == word_id for w in config.get('words', [])):
        raise HTTPException(status_code=400, detail={
            'error_code': 'VALIDATION_ERROR',
            'message': f"Word ID '{word_id}' already exists in this template"
        })

    config.setdefault('words', []).append({
        'id': word_id,
        'label': label,
        'type': 'text',
        'text': text,
        'font': font,
        'color': color,
        'align': align,
    })
    _save_raw_config(template_id, config)
    return {'ok': True, 'word_id': word_id, 'label': label}


@router.delete('/templates/{template_id}/words/{word_id}')
async def delete_word(template_id: str, word_id: str):
    config = _load_raw_config(template_id)
    word_obj = next((w for w in config.get('words', []) if w['id'] == word_id), None)
    config['words'] = [w for w in config.get('words', []) if w['id'] != word_id]
    for bundle in config.get('bundles', []):
        bundle['words'] = [wid for wid in bundle['words'] if wid != word_id]
    if word_obj and word_obj.get('type', 'asset') != 'text':
        filename = word_obj.get('svg_filename', '')
        if filename:
            asset_path = wtm_config.WTM_TEMPLATES_DIR / template_id / 'words' / filename
            if asset_path.exists():
                asset_path.unlink()
    _save_raw_config(template_id, config)
    return {'ok': True}


@router.get('/templates/{template_id}/words/{word_id}/svg')
async def get_word_svg(template_id: str, word_id: str):
    if not _safe_id(word_id):
        raise HTTPException(status_code=400, detail='Invalid word_id')
    words_dir = wtm_config.WTM_TEMPLATES_DIR / template_id / 'words'
    svg_path = words_dir / f'{word_id}.svg'
    if svg_path.exists():
        return FileResponse(str(svg_path), media_type='image/svg+xml')
    png_path = words_dir / f'{word_id}.png'
    if png_path.exists():
        return FileResponse(str(png_path), media_type='image/png')
    raise HTTPException(status_code=404, detail='Word asset not found')


# ── Bundle Management ──────────────────────────────────────────────────

@router.put('/templates/{template_id}/text-overlay')
async def save_text_overlay(template_id: str, req: SaveTextOverlayRequest):
    """Save or remove a name_text / designation_text overlay for a WTM template."""
    if not _safe_id(template_id):
        raise HTTPException(status_code=400, detail='Invalid template_id')
    config = _load_raw_config(template_id)

    if req.config is None:
        config.pop(req.field, None)
    else:
        if req.config.font_name:
            from utils.wtm_utils import find_font_path
            if find_font_path(req.config.font_name) is None:
                raise HTTPException(status_code=400, detail={
                    'error_code': 'INVALID_FONT',
                    'message': f"Font '{req.config.font_name}' not found in backend/fonts/"
                })
        config[req.field] = req.config.model_dump()

    _save_raw_config(template_id, config)
    return {'ok': True}


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
