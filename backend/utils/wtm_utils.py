import cairosvg, io, hashlib
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import logging

logger = logging.getLogger(__name__)

FONTS_DIR = Path(__file__).resolve().parent.parent / 'fonts'


def list_available_fonts() -> list[dict]:
    """Scan backend/fonts/ recursively for .ttf/.otf files."""
    fonts = []
    if not FONTS_DIR.exists():
        return fonts
    for p in sorted(FONTS_DIR.rglob('*')):
        if p.suffix.lower() in ('.ttf', '.otf'):
            fonts.append({'name': p.stem, 'display': p.stem.replace('-', ' ').replace('_', ' ')})
    return fonts


def find_font_path(font_name: str) -> Path | None:
    """Find a font file by stem name (case-insensitive) under backend/fonts/."""
    if not FONTS_DIR.exists():
        return None
    for p in FONTS_DIR.rglob('*'):
        if p.suffix.lower() in ('.ttf', '.otf') and p.stem.lower() == font_name.lower():
            return p
    return None


def render_text_word(
    text: str,
    slot_w: int,
    slot_h: int,
    font_name: str,
    color: str = '#000000',
    align: str = 'center',
) -> Image.Image | None:
    """Render text onto a transparent RGBA canvas sized to the slot."""
    font_path = find_font_path(font_name)
    if font_path is None:
        logger.error(f'Font not found: {font_name}')
        return None
    try:
        size = _fit_font_size(text, str(font_path), int(slot_w * 0.92), int(slot_h * 0.82))
        font = ImageFont.truetype(str(font_path), size)

        img = Image.new('RGBA', (slot_w, slot_h), (0, 0, 0, 0))
        draw = ImageDraw.Draw(img)

        bbox = draw.textbbox((0, 0), text, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]

        pad = int(slot_w * 0.04)
        if align == 'left':
            x = pad - bbox[0]
        elif align == 'right':
            x = slot_w - text_w - pad - bbox[0]
        else:
            x = (slot_w - text_w) // 2 - bbox[0]

        y = (slot_h - text_h) // 2 - bbox[1]

        r, g, b = _hex_to_rgb(color)
        draw.text((x, y), text, font=font, fill=(r, g, b, 255))
        return img
    except Exception as e:
        logger.error(f'Text render failed for "{text}": {e}')
        return None


def _fit_font_size(text: str, font_path: str, max_w: int, max_h: int) -> int:
    """Binary search for the largest font size that fits text within max_w × max_h."""
    lo, hi, best = 8, 600, 8
    while lo <= hi:
        mid = (lo + hi) // 2
        try:
            font = ImageFont.truetype(font_path, mid)
            dummy_img = Image.new('RGBA', (1, 1))
            draw = ImageDraw.Draw(dummy_img)
            bbox = draw.textbbox((0, 0), text, font=font)
            if (bbox[2] - bbox[0]) <= max_w and (bbox[3] - bbox[1]) <= max_h:
                best = mid
                lo = mid + 1
            else:
                hi = mid - 1
        except Exception:
            hi = mid - 1
    return best


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip('#')
    if len(h) == 3:
        h = ''.join(c * 2 for c in h)
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


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


def load_png_word(png_path: Path) -> Image.Image | None:
    """Load PNG word asset directly as RGBA. Returns None on any failure."""
    try:
        img = Image.open(png_path).convert('RGBA')
        if img.width == 0 or img.height == 0:
            logger.error(f'PNG has zero dimension: {png_path}')
            return None
        return img
    except Exception as e:
        logger.error(f'PNG load failed for {png_path}: {e}')
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


def make_cache_key(template_id: str, sorted_words: list[str], config_version: str = '') -> str:
    """SHA-256 of template_id + sorted words + config version (updated_at).
    Including config_version ensures stale disk-cache PNGs are bypassed whenever
    the template config changes (e.g. slot rotation saved in admin)."""
    key_str = f"{template_id}|{','.join(sorted_words)}|{config_version}"
    return hashlib.sha256(key_str.encode('utf-8')).hexdigest()
