import json, re, logging
from pathlib import Path
from config import settings

logger = logging.getLogger(__name__)

WTM_TEMPLATES_DIR = Path(settings.WTM_TEMPLATES_DIR)
WTM_CACHE_DIR = Path(settings.WTM_CACHE_DIR)

# Module-level config store. Only valid configs are stored here.
_configs: dict[str, dict] = {}

def _validate_config(config: dict, template_dir: Path) -> list[str]:
    """Returns list of error strings. Empty list = valid."""
    errors = []

    if config.get('mode') != 'word_template':
        errors.append(f"mode must be 'word_template', got: {config.get('mode')}")

    dims = config.get('dimensions', {})
    w, h = dims.get('width', 0), dims.get('height', 0)
    if w <= 0 or h <= 0:
        errors.append('dimensions.width and height must be > 0')

    base_path = template_dir / config.get('base_image', '')
    if not base_path.exists():
        errors.append(f"base_image not found: {base_path}")
    else:
        try:
            from PIL import Image
            Image.MAX_IMAGE_PIXELS = None  # trusted admin file — skip bomb check
            with Image.open(base_path) as img:
                actual_w, actual_h = img.width, img.height
            Image.MAX_IMAGE_PIXELS = 178956970  # restore default
            if actual_w != w or actual_h != h:
                errors.append(
                    f"dimensions mismatch: config says {w}x{h}, "
                    f"actual image is {actual_w}x{actual_h}"
                )
        except Exception as e:
            Image.MAX_IMAGE_PIXELS = 178956970  # restore even on error
            errors.append(f"could not read base_image: {e}")

    slots = config.get('slots', [])
    if len(slots) > 6:
        errors.append(f"slots must have at most 6 items, got {len(slots)}")
    elif len(slots) > 0:
        orders = sorted([s.get('order', -1) for s in slots])
        if orders != list(range(len(slots))):
            errors.append(f"slot orders must be sequential with no gaps, got {orders}")
        for slot in slots:
            sx, sy = slot.get('x', 0), slot.get('y', 0)
            sw, sh = slot.get('width', 0), slot.get('height', 0)
            if sx + sw > w:
                errors.append(f"slot {slot.get('id')}: x+width exceeds image width")
            if sy + sh > h:
                errors.append(f"slot {slot.get('id')}: y+height exceeds image height")
            if sw < 50 or sh < 50:
                errors.append(f"slot {slot.get('id')}: width/height must be >= 50px")

    word_ids = set()
    for word in config.get('words', []):
        wid = word.get('id', '')
        if not re.match(r'^[a-z0-9-]+$', wid):
            errors.append(f"word id '{wid}' must match ^[a-z0-9-]+$")
        if wid in word_ids:
            errors.append(f"duplicate word id: {wid}")
        word_ids.add(wid)
        word_type = word.get('type', 'asset')
        if word_type == 'text':
            if not word.get('font'):
                errors.append(f"text word '{wid}' missing font")
        else:
            filename = word.get('svg_filename', '')
            if not filename:
                errors.append(f"asset word '{wid}' missing svg_filename")
            else:
                asset_path = template_dir / 'words' / filename
                if not asset_path.exists():
                    errors.append(f"asset file not found for word '{wid}': {asset_path}")

    for bundle in config.get('bundles', []):
        for wid in bundle.get('words', []):
            if wid not in word_ids:
                errors.append(f"bundle '{bundle.get('id')}' references unknown word: {wid}")
        if len(bundle.get('words', [])) > 6:
            errors.append(f"bundle '{bundle.get('id')}' has more than 6 words")

    return errors

def load_all_configs() -> None:
    """Scan all WTM template directories and load valid configs."""
    if not WTM_TEMPLATES_DIR.exists():
        logger.info('WTM_TEMPLATES_DIR does not exist yet — no templates to load')
        return
    count = 0
    for template_dir in WTM_TEMPLATES_DIR.iterdir():
        if not template_dir.is_dir():
            continue
        config_path = template_dir / 'config.json'
        if not config_path.exists():
            continue
        try:
            with open(config_path) as f:
                config = json.load(f)
            errors = _validate_config(config, template_dir)
            if errors:
                logger.error(f'WTM config invalid for {template_dir.name}: {errors}')
                continue
            _configs[config['template_id']] = config
            count += 1
        except Exception as e:
            logger.error(f'WTM config load failed for {template_dir.name}: {e}')
    logger.info(f'WTM: loaded {count} valid template configs')


def get_config(template_id: str) -> dict:
    """Raises HTTPException 400 if template not found or invalid."""
    if template_id not in _configs:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=400,
            detail={
                'error_code': 'INVALID_TEMPLATE',
                'message': f'WTM template not found: {template_id}'
            }
        )
    return _configs[template_id]


def reload_config(template_id: str) -> None:
    """Re-reads config.json for one template. Called after admin saves."""
    template_dir = WTM_TEMPLATES_DIR / template_id
    config_path = template_dir / 'config.json'
    if not config_path.exists():
        _configs.pop(template_id, None)
        return
    try:
        with open(config_path) as f:
            config = json.load(f)
        errors = _validate_config(config, template_dir)
        if errors:
            logger.error(f'WTM config invalid after reload for {template_id}: {errors}')
            _configs.pop(template_id, None)
        else:
            _configs[template_id] = config
            logger.info(f'WTM config reloaded: {template_id}')
    except Exception as e:
        logger.error(f'WTM config reload failed for {template_id}: {e}')
        _configs.pop(template_id, None)
