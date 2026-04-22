import asyncio, time, logging, os
from pathlib import Path
from PIL import Image
from config import settings
from services.wtm_cache import wtm_cache
from services.wtm_config import WTM_TEMPLATES_DIR, WTM_CACHE_DIR
from utils.wtm_utils import rasterize_svg, load_png_word, render_text_word, compute_fit, make_cache_key
from schemas.wtm_schemas import ComposeResponse

logger = logging.getLogger(__name__)

SVG_RASTER_SCALE = int(os.environ.get('WTM_SVG_RASTER_SCALE', '3'))
COMPOSE_TIMEOUT = float(os.environ.get('WTM_COMPOSE_TIMEOUT', '30'))

_compose_locks: dict[str, asyncio.Lock] = {}
_locks_mutex = asyncio.Lock()


async def compose_template(config: dict, selected_words: list[str]) -> ComposeResponse:
    """
    Main entry point. selected_words already sorted by Pydantic validator
    but sort again defensively.
    """
    sorted_words = sorted(selected_words)
    cache_key = make_cache_key(config['template_id'], sorted_words, config.get('updated_at', ''))

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
                timeout=COMPOSE_TIMEOUT
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

    # Suppress decompression bomb check — this file was uploaded by a trusted admin
    Image.MAX_IMAGE_PIXELS = None
    base = Image.open(base_path).convert('RGBA')
    Image.MAX_IMAGE_PIXELS = 178956970  # restore default

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

        if word_obj.get('type') == 'text':
            _paste_text_into_slot(base, word_obj, slot)
        else:
            svg_path = template_dir / 'words' / word_obj['svg_filename']
            if not svg_path.exists():
                logger.error(f'Asset missing: {svg_path}, skipping slot {i}')
                continue
            _paste_word_into_slot(base, svg_path, slot)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    base.save(str(output_path), 'PNG')
    return output_path


def _paste_word_into_slot(base: Image.Image, svg_path: Path, slot: dict) -> None:
    """Load word asset (SVG or PNG), scale to fit slot, optionally rotate, center, paste."""
    rotation = slot.get('rotation', 0) or 0

    if svg_path.suffix.lower() == '.png':
        word_img = load_png_word(svg_path)
    else:
        word_img = rasterize_svg(
            svg_path,
            target_width=slot['width'] * SVG_RASTER_SCALE,
            target_height=slot['height'] * SVG_RASTER_SCALE
        )
    if word_img is None:
        logger.error(f'Failed to load word asset {svg_path}, skipping slot')
        return

    fit_w, fit_h = compute_fit(word_img.width, word_img.height, slot['width'], slot['height'])
    word_img = word_img.resize((fit_w, fit_h), Image.LANCZOS)

    if rotation:
        # PIL rotates counter-clockwise; negate so positive = clockwise (matching UI/CSS)
        word_img = word_img.rotate(-rotation, expand=True, resample=Image.BICUBIC)

    # Center the (possibly rotated, expanded) image over the slot centre
    slot_cx = slot['x'] + slot['width'] // 2
    slot_cy = slot['y'] + slot['height'] // 2
    paste_x = slot_cx - word_img.width // 2
    paste_y = slot_cy - word_img.height // 2

    if word_img.mode == 'RGBA':
        base.paste(word_img, (paste_x, paste_y), word_img)
    else:
        base.paste(word_img.convert('RGBA'), (paste_x, paste_y))


def _paste_text_into_slot(base: Image.Image, word_obj: dict, slot: dict) -> None:
    """Render text word directly into slot using configured font/color/align."""
    rotation = slot.get('rotation', 0) or 0
    text = word_obj.get('text') or word_obj.get('label', '')

    word_img = render_text_word(
        text=text,
        slot_w=slot['width'],
        slot_h=slot['height'],
        font_name=word_obj.get('font', ''),
        color=word_obj.get('color', '#000000'),
        align=word_obj.get('align', 'center'),
    )
    if word_img is None:
        logger.error(f'Text render failed for word "{word_obj.get("id")}", skipping slot')
        return

    if rotation:
        word_img = word_img.rotate(-rotation, expand=True, resample=Image.BICUBIC)

    slot_cx = slot['x'] + slot['width'] // 2
    slot_cy = slot['y'] + slot['height'] // 2
    paste_x = slot_cx - word_img.width // 2
    paste_y = slot_cy - word_img.height // 2

    base.paste(word_img, (paste_x, paste_y), word_img)
