# IMPL-01 — Backend Core: Schemas, Config Loader, Cache, Utils
## Files to Create
- `backend/schemas/__init__.py`
- `backend/schemas/wtm_schemas.py`
- `backend/utils/__init__.py`
- `backend/utils/wtm_utils.py`
- `backend/services/wtm_config.py`
- `backend/services/wtm_cache.py`
- `tests/__init__.py`
- `tests/wtm/__init__.py`
- `tests/wtm/test_config.py`
- `tests/wtm/test_cache.py`

## Files to Modify
- `backend/config.py` — add 2 settings inside Settings class
- `backend/requirements.txt` — add cairosvg and cairocffi

## Prerequisite
None. This is session 1. All other sessions depend on these files.

## Modify: backend/config.py
Add these two lines inside the `Settings` class, after `OUTPUTS_DIR`:
```python
WTM_TEMPLATES_DIR: str = "templates/wtm"
WTM_CACHE_DIR: str = "templates/wtm_cache"
```
Nothing else changes in config.py.

## Modify: backend/requirements.txt
Add:
```
cairosvg>=2.7.0
cairocffi>=1.6.0
```
Pillow is already installed. Do not add it again.

Add to Dockerfile before pip install:
```dockerfile
RUN apt-get update && apt-get install -y \
    libcairo2-dev \
    libpango1.0-dev \
    libgdk-pixbuf2.0-dev \
    libffi-dev \
    && rm -rf /var/lib/apt/lists/*
```

---

## backend/schemas/wtm_schemas.py — Implement Exactly

```python
from pydantic import BaseModel, validator, Field
from typing import List, Optional
import re


# ── Guest-facing models ────────────────────────────────────────────────

class ComposeRequest(BaseModel):
    template_id: str = Field(..., regex=r'^[a-zA-Z0-9_-]+$')
    selected_words: List[str] = Field(..., min_items=1, max_items=6)

    @validator('selected_words')
    def deduplicate_and_sort(cls, v):
        # Deduplicate silently, then sort for deterministic cache key
        return sorted(list(set(v)))

    @validator('selected_words', each_item=True)
    def word_id_format(cls, v):
        if not re.match(r'^[a-z0-9-]+$', v):
            raise ValueError(f'Invalid word ID format: {v}')
        return v

class ComposeResponse(BaseModel):
    template_path: str
    cache_hit: bool
    compose_time_ms: Optional[int] = None  # None on cache hit

class WordItem(BaseModel):
    id: str
    label: str
    svg_path: str  # server-side path — frontend never uses this

class BundleItem(BaseModel):
    id: str
    label: str
    words: List[str]

class WordsResponse(BaseModel):
    template_id: str
    words: List[WordItem]
    bundles: List[BundleItem]
    max_selections: int = 6
    slot_count: int

class WTMError(BaseModel):
    error_code: str
    message: str
    detail: Optional[str] = None


# ── Admin models ───────────────────────────────────────────────────────

class SlotDefinition(BaseModel):
    id: str = Field(..., regex=r'^[a-zA-Z0-9_]+$')
    order: int = Field(..., ge=0)
    x: int = Field(..., ge=0)
    y: int = Field(..., ge=0)
    width: int = Field(..., ge=50)   # 50px minimum — matches TemplateEditor.tsx threshold
    height: int = Field(..., ge=50)  # 50px minimum — matches TemplateEditor.tsx threshold

class SaveSlotsRequest(BaseModel):
    slots: List[SlotDefinition] = Field(..., min_items=1, max_items=6)

class BundleDefinition(BaseModel):
    id: str
    label: str
    words: List[str] = Field(..., max_items=6)

class SaveBundlesRequest(BaseModel):
    bundles: List[BundleDefinition]

class WTMTemplateListItem(BaseModel):
    template_id: str
    name: str
    slot_count: int
    word_count: int
    created_at: str
```

---

## backend/services/wtm_config.py — Implement Exactly

### Path resolution (top of file)
```python
import json, re, logging
from pathlib import Path
from config import settings

logger = logging.getLogger(__name__)

WTM_TEMPLATES_DIR = Path(settings.WTM_TEMPLATES_DIR)
WTM_CACHE_DIR = Path(settings.WTM_CACHE_DIR)

# Module-level config store. Only valid configs are stored here.
_configs: dict[str, dict] = {}
```

### Responsibilities
1. On `load_all_configs()`: scan all `templates/wtm/*/config.json`.
2. Validate each config against all rules below.
3. Verify base_image exists and dimensions match actual PNG (use PIL).
4. Verify every word's svg_filename exists on disk.
5. Store valid configs in `_configs`. Invalid ones: log + skip. Never crash.
6. `get_config(template_id)` raises HTTPException 400 if not found.
7. `reload_config(template_id)` re-reads one config after admin saves.

### _validate_config function
```python
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
            with Image.open(base_path) as img:
                if img.width != w or img.height != h:
                    errors.append(
                        f"dimensions mismatch: config says {w}x{h}, "
                        f"actual image is {img.width}x{img.height}"
                    )
        except Exception as e:
            errors.append(f"could not read base_image: {e}")

    slots = config.get('slots', [])
    if not (1 <= len(slots) <= 6):
        errors.append(f"slots must have 1-6 items, got {len(slots)}")
    else:
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
        svg_path = template_dir / 'words' / word.get('svg_filename', '')
        if not svg_path.exists():
            errors.append(f"SVG not found for word '{wid}': {svg_path}")

    for bundle in config.get('bundles', []):
        for wid in bundle.get('words', []):
            if wid not in word_ids:
                errors.append(f"bundle '{bundle.get('id')}' references unknown word: {wid}")
        if len(bundle.get('words', [])) > 6:
            errors.append(f"bundle '{bundle.get('id')}' has more than 6 words")

    return errors
```

### load_all_configs, get_config, reload_config
```python
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
```

---

## backend/services/wtm_cache.py — Implement Exactly

```python
from collections import OrderedDict
from threading import Lock


class WTMCache:
    def __init__(self, max_size: int = 200):
        self._cache: OrderedDict[str, str] = OrderedDict()
        self._max = max_size
        self._lock = Lock()

    def get(self, key: str) -> str | None:
        with self._lock:
            if key not in self._cache:
                return None
            self._cache.move_to_end(key)
            return self._cache[key]

    def put(self, key: str, value: str) -> None:
        with self._lock:
            if key in self._cache:
                self._cache.move_to_end(key)
            self._cache[key] = value
            if len(self._cache) > self._max:
                self._cache.popitem(last=False)

    def clear(self) -> None:
        with self._lock:
            self._cache.clear()


# Module-level singleton — import this everywhere
wtm_cache = WTMCache(max_size=200)
```

---

## backend/utils/wtm_utils.py — Implement Exactly

```python
import cairosvg, io, hashlib
from pathlib import Path
from PIL import Image
import logging

logger = logging.getLogger(__name__)


def rasterize_svg(svg_path: Path, target_width: int, target_height: int) -> Image.Image | None:
    """Rasterize SVG to PIL RGBA image. Returns None on any failure."""
    try:
        png_bytes = cairosvg.svg2png(
            url=str(svg_path),
            output_width=target_width,
            output_height=target_height
        )
        img = Image.open(io.BytesIO(png_bytes)).convert('RGBA')
        if img.width == 0 or img.height == 0:
            logger.error(f'cairosvg returned 0-dimension image for {svg_path}')
            return None
        return img
    except Exception as e:
        logger.error(f'SVG rasterization failed for {svg_path}: {e}')
        return None


def compute_fit(src_w: int, src_h: int, box_w: int, box_h: int) -> tuple[int, int]:
    """
    Returns (fit_width, fit_height) preserving aspect ratio.
    Result always fits inside box. Never crops.
    """
    if src_w == 0 or src_h == 0:
        return (box_w, box_h)
    scale = min(box_w / src_w, box_h / src_h)
    return (max(1, int(src_w * scale)), max(1, int(src_h * scale)))


def make_cache_key(template_id: str, sorted_words: list[str]) -> str:
    """SHA-256 of template_id + '|' + sorted comma-joined words."""
    key_str = f"{template_id}|{','.join(sorted_words)}"
    return hashlib.sha256(key_str.encode('utf-8')).hexdigest()
```

---

## Required Tests — tests/wtm/test_config.py

| Test | What to assert |
|------|---------------|
| `test_valid_config_loads` | Valid config → present in _configs |
| `test_slot_x_out_of_bounds` | slot x + width > dims.width → rejected |
| `test_slot_y_out_of_bounds` | slot y + height > dims.height → rejected |
| `test_duplicate_slot_order` | Two slots same order → rejected |
| `test_gap_in_slot_order` | Orders [0,1,3] → rejected |
| `test_zero_slots` | Empty slots array → rejected |
| `test_seven_slots` | 7 slot items → rejected |
| `test_missing_base_image` | base.png not on disk → rejected |
| `test_missing_svg` | word svg_filename not on disk → rejected |
| `test_invalid_word_id` | Word id contains uppercase → rejected |
| `test_slot_too_small` | Slot width < 50 → rejected |
| `test_bundle_unknown_word` | Bundle references word not in words array → rejected |
| `test_dimension_mismatch` | dimensions.width != actual PNG width → rejected |
| `test_reload_config` | Save updated config → reload → get_config returns new data |
| `test_get_config_missing_raises_400` | get_config("nonexistent") → HTTPException 400 |
| `test_load_survives_zero_valid_templates` | All configs invalid → load_all_configs() does not raise |

## Required Tests — tests/wtm/test_cache.py

| Test | What to assert |
|------|---------------|
| `test_get_miss` | get on empty cache → None |
| `test_put_and_get` | put then get → returns value |
| `test_lru_eviction` | Fill to max_size + 1 → oldest entry evicted |
| `test_lru_get_promotes` | Get old entry, fill to threshold → accessed entry NOT evicted |
| `test_clear` | Put 5 items, clear → all return None |
| `test_thread_safety` | 50 concurrent threads doing random get/put → no exceptions |
