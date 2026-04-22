"""
Image Compositing Service (SmartFit v1 + Face Anchor v1)
========================================================
Handles sticker placement with booth-grade accuracy.

Pipeline:
1. Crop to Alpha BBox (remove transparent padding)
2. Fit to Slot (using desiredFaceRatio if available)
3. Calculate Placement (using Face Landmarks if available)
"""

import os
import json
import time
from types import SimpleNamespace
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
from typing import Tuple, Optional, Dict, List
from dataclasses import dataclass
from functools import lru_cache
import json
from services.face_service import FaceLandmarks


@lru_cache(maxsize=8)
def _load_template_image(path: str) -> Image.Image:
    """Cache template PNGs in memory to avoid repeated disk I/O."""
    print(f"INFO: Loading template image into cache: {os.path.basename(path)}", flush=True)
    return Image.open(path).convert("RGBA")

@lru_cache(maxsize=16)
def _get_resized_template(path: str, width: int, height: int) -> Image.Image:
    """Load and resize template, caching the result to avoid repeated BICUBIC math."""
    print(f"INFO: Resizing template cache: {os.path.basename(path)} -> {width}x{height}", flush=True)
    img = _load_template_image(path)
    if img.size != (width, height):
        return img.resize((width, height), Image.Resampling.LANCZOS)
    return img.copy()

@dataclass
class SlotMetadata:
    """Metadata for a single template slot."""
    slot_id: str
    x: int
    y: int
    width: int
    height: int
    # Anchor target: can be relative (0.0-1.0) or absolute (pixels)
    anchor_target_x: Optional[float] = None
    anchor_target_y: Optional[float] = None
    z_index: int = 0
    # Face Sizing
    desired_face_ratio: Optional[float] = None  # e.g., 0.35 of slot height
    min_zoom: float = 0.5
    max_zoom: float = 3.0

@dataclass
class MagazineTextConfig:
    """
    Configuration for rendering a single dynamic text element (NAME or DESIGNATION)
    on the magazine canvas using Pillow ImageDraw.

    Coordinates are in the template's native pixel space (matching the dimensions
    stored in the JSON). They are scaled by res_multiplier at render time.
    """
    x: int                      # Left edge of text in template-native pixels
    y: int                      # Top edge of text in template-native pixels
    font_size: int              # Font size in template-native pixels (scaled at render)
    color: str = "#FFFFFF"      # CSS hex color, e.g. "#FFFFFF" or "white"
    font_path: str = ""         # Absolute path to a .ttf font file; empty = use default
    max_width: int = 0          # If > 0, text is clamped/wrapped to this width (native px)
    align: str = "left"         # "left", "center", "right"
    uppercase: bool = False     # If True, force text to uppercase before drawing

@dataclass
class TemplateMetadata:
    """Full template configuration."""
    template_id: str
    name: str
    png_path: str
    slots: List[SlotMetadata]
    anchor_mode: str  # face_center, eyes, bbox_center, none
    width: int
    height: int
    template_type: str = "sticker" # frame, sticker, magazine
    composite_mode: str = "overlay"  # "overlay" = template on top, "background" = template behind sticker, "magazine" = BG→user→FG sandwich
    sticker_filter: str = "none"  # "none", "bw", "sketch"
    fg_path: str = ""  # Magazine mode: foreground overlay PNG (goes on top of user)
    fg_offset: Optional[Dict] = None  # Magazine mode: FG overlay position offset {x, y}

    # Magazine mode: dynamic text positions
    name_text: Optional['MagazineTextConfig'] = None         # Where to draw the person's name
    designation_text: Optional['MagazineTextConfig'] = None  # Where to draw their designation

def clear_template_cache():
    """Clear in-memory caches when templates are updated."""
    load_template_metadata.cache_clear()
    _load_template_image.cache_clear()
    _get_resized_template.cache_clear()

@lru_cache(maxsize=32)
def load_template_metadata(template_id: str, templates_dir: Optional[str] = None) -> Optional[TemplateMetadata]:
    """Load template metadata from JSON file."""
    if templates_dir is None:
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        templates_dir = os.path.join(project_root, "templates")
    
    # Case-insensitive lookup helper
    def find_file_case_insensitive(directory, target_name):
        if not os.path.exists(directory):
            return None
        target_lower = target_name.lower()
        for entry in os.listdir(directory):
            if entry.lower() == target_lower:
                return os.path.join(directory, entry)
        return None

    # Try multiple potential filenames
    json_path = find_file_case_insensitive(templates_dir, f"{template_id}.json")
    if not json_path:
        json_path = find_file_case_insensitive(templates_dir, os.path.basename(template_id) + ".json")
    
    if json_path and os.path.exists(json_path):
        try:
            with open(json_path, 'r') as f:
                data = json.load(f)
            
            slots = []
            for slot_data in data.get("slots", []):
                anchor = slot_data.get("anchorTarget", slot_data.get("anchor", {}))
                slots.append(SlotMetadata(
                    slot_id=slot_data.get("id", slot_data.get("slotId", "main")),
                    x=slot_data["x"],
                    y=slot_data["y"],
                    width=slot_data["width"],
                    height=slot_data["height"],
                    anchor_target_x=anchor.get("x", anchor.get("targetX")),
                    anchor_target_y=anchor.get("y", anchor.get("targetY")),
                    z_index=slot_data.get("zIndex", 0),
                    desired_face_ratio=slot_data.get("desiredFaceRatio"),
                    min_zoom=slot_data.get("minZoom", 0.5),
                    max_zoom=slot_data.get("maxZoom", 3.0),
                ))
            
            dimensions = data.get("dimensions", {})
            w = dimensions.get("width", data.get("width", 1200))
            h = dimensions.get("height", data.get("height", 1600))
            
            # Path to the actual PNG
            png_url = data.get("png_path", data.get("pngUrl", ""))
            
            # Try to resolve png_path case-insensitively if it's just a filename
            resolved_png_path = find_file_case_insensitive(templates_dir, png_url)
            if resolved_png_path:
                png_url = os.path.basename(resolved_png_path)
            
            png_path = os.path.join(templates_dir, png_url)
            
            # SENSOR: Auto-detect real dimensions if placeholder (400) or missing
            # This prevents "blank image" errors caused by resolution mismatches
            if os.path.exists(png_path) and (w <= 400 or h <= 400):
                try:
                    with Image.open(png_path) as img:
                        real_w, real_height = img.size
                        print(f"DEBUG: Detected real dimensions for {template_id}: {real_w}x{real_height} (Override {w}x{h})", flush=True)
                        w, h = real_w, real_height
                except Exception as img_err:
                    print(f"ERROR: Could not read image dimensions for {png_path}: {img_err}")

            # Resolve fg_path the same way as png_path (case-insensitive)
            raw_fg = data.get("fg_path", "")
            if raw_fg:
                resolved_fg = find_file_case_insensitive(templates_dir, raw_fg)
                if resolved_fg:
                    raw_fg = os.path.basename(resolved_fg)

            # --- Magazine text config ---
            def _parse_text_cfg(raw: dict) -> Optional[MagazineTextConfig]:
                if not raw:
                    return None
                return MagazineTextConfig(
                    x=int(raw.get("x", 0)),
                    y=int(raw.get("y", 0)),
                    font_size=int(raw.get("fontSize", 60)),
                    color=raw.get("color", "#FFFFFF"),
                    font_path=raw.get("fontPath", ""),
                    max_width=int(raw.get("maxWidth", 0)),
                    align=raw.get("align", "left"),
                    uppercase=bool(raw.get("uppercase", False)),
                )

            name_text_cfg = _parse_text_cfg(data.get("name_text", {}))
            designation_text_cfg = _parse_text_cfg(data.get("designation_text", {}))

            raw_fg_offset = data.get("fg_offset")
            fg_offset = raw_fg_offset if isinstance(raw_fg_offset, dict) else None

            return TemplateMetadata(
                template_id=data.get("templateId", data.get("id", template_id)),
                name=data.get("name", "Unnamed"),
                png_path=png_url,
                fg_path=raw_fg,
                fg_offset=fg_offset,
                slots=slots,
                anchor_mode=data.get("anchorMode", "bbox_center"),
                width=w,
                height=h,
                template_type=data.get("templateType", data.get("mode", "sticker")),
                composite_mode=data.get("compositeMode", "overlay"),
                sticker_filter=data.get("stickerFilter", "none"),
                name_text=name_text_cfg,
                designation_text=designation_text_cfg,
            )
        except Exception as e:
            print(f"Error parse template {json_path}: {e}")
    return None

class ComposeService:
    """
    Service for compositing stickers onto templates with SmartFit logic.
    """
    
    def crop_to_alpha_bbox(self, sticker: Image.Image, anchor_mode: str = "bbox_center") -> Image.Image:
        """
        Crop image to the bounding box of non-transparent pixels.
        Ensures we are working with the actual subject, not empty space.
        
        If anchor_mode is 'full_frame', skip cropping entirely to preserve the absolute 
        physical placement from the user's camera (e.g., green screen style overlays).
        """
        if anchor_mode == "full_frame":
            print("DEBUG SmartFit: 'full_frame' active. Skipping bounding box crop to preserve absolute position.")
            return sticker
            
        if sticker.mode != "RGBA":
            sticker = sticker.convert("RGBA")
        
        alpha = sticker.getchannel("A")
        bbox = alpha.getbbox()
        
        if bbox:
            return sticker.crop(bbox)
        
        # If image is fully transparent, return 1x1 empty pixel to avoid crashes
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

    def apply_sticker_filter(self, sticker: Image.Image, filter_type: str) -> Image.Image:
        """Apply high-contrast B&W or Pencil Sketch filter to sticker."""
        if not filter_type or filter_type == "none":
            return sticker

        if sticker.mode != "RGBA":
            sticker = sticker.convert("RGBA")

        r, g, b, a = sticker.split()
        rgb_img = Image.merge("RGB", (r, g, b))

        if filter_type == "bw":
            gray = ImageOps.grayscale(rgb_img)
            enhancer = ImageEnhance.Contrast(gray)
            gray = enhancer.enhance(1.5)
            rgb_img = gray.convert("RGB")

        elif filter_type == "sketch":
            gray = ImageOps.grayscale(rgb_img)
            edges = gray.filter(ImageFilter.FIND_EDGES)
            inv_edges = ImageOps.invert(edges)
            rgb_img = inv_edges.convert("RGB")

        r, g, b = rgb_img.split()
        return Image.merge("RGBA", (r, g, b, a))

    def resolve_anchor_to_pixels(self, val: Optional[float], dimension_size: int) -> Optional[int]:
        """Convert float relative anchor (0.5) to pixels (600)."""
        if val is None:
            return None
        # If <= 1.0, assume relative ratio
        if 0.0 <= val <= 1.0:
            return int(val * dimension_size)
        # Else assume absolute pixels
        return int(val)

    def fit_sticker_to_slot(
        self,
        sticker: Image.Image,
        slot: SlotMetadata,
        fit_mode: str = "contain",
        face_height: Optional[int] = None,
    ) -> Image.Image:
        """
        Scale sticker to fit within slot. 
        Uses Face Size Normalization if face_height and desired_face_ratio are present.
        """
        sticker_w, sticker_h = sticker.size
        if sticker_w == 0 or sticker_h == 0:
            return sticker
            
        anchor_mode = getattr(slot, '_temp_anchor_mode', 'none')
        
        print(f"DEBUG SmartFit: Input sticker={sticker_w}×{sticker_h}, slot={slot.width}×{slot.height}, mode={fit_mode}, anchor={anchor_mode}")
        
        # === FULL FRAME ANCHORING (Green screen logic) ===
        if anchor_mode == "full_frame":
            # Just forcefully resize the uncropped camera capture to perfectly map the slot (which should be template size)
            print(f"DEBUG SmartFit: 'full_frame' scaling. Forcing output={slot.width}×{slot.height}")
            return sticker.resize((slot.width, slot.height), Image.Resampling.BICUBIC)
            
        # Logic 1: Face Size Normalization
        # Skip face size normalization if anchor_mode is 'none' (user wants it dumped in the box)
        if face_height and slot.desired_face_ratio and getattr(slot, '_temp_anchor_mode', 'none') != 'none':
            target_face_h = slot.height * slot.desired_face_ratio
            scale = target_face_h / face_height
            
            # Clamp scale
            scale = max(slot.min_zoom, min(slot.max_zoom, scale))
            
            new_w = int(sticker_w * scale)
            new_h = int(sticker_h * scale)
            
            print(f"DEBUG SmartFit: Face-based scaling. Ratio={slot.desired_face_ratio}, Scale={scale:.2f}, output={new_w}×{new_h}")
            return sticker.resize((new_w, new_h), Image.Resampling.BICUBIC)

        # Logic 2: Standard Fit (no face detected)
        slot_w, slot_h = slot.width, slot.height
        
        if fit_mode == "contain":
            # For stickers (typically people with BG removed):
            # Scale to FILL the slot HEIGHT - this ensures the person is full-size
            # We want the sticker to be as tall as the slot (minus some padding)
            target_fill_ratio = 0.90  # 90% of slot height
            
            # Scale based on HEIGHT (not the smaller dimension)
            scale = (slot_h * target_fill_ratio) / sticker_h
            
            # Clamp scale to reasonable bounds
            scale = max(slot.min_zoom, min(slot.max_zoom, scale))
            
            print(f"DEBUG SmartFit: Height-fill mode. Scale={scale:.2f}")
        else:  # cover
            scale = max(slot_w / sticker_w, slot_h / sticker_h)
            print(f"DEBUG SmartFit: Cover mode. Scale={scale:.2f}")
            
        new_w = int(sticker_w * scale)
        new_h = int(sticker_h * scale)
        print(f"DEBUG SmartFit: Output={new_w}×{new_h}")
        return sticker.resize((new_w, new_h), Image.Resampling.BICUBIC)

    def calculate_placement(
        self,
        sticker: Image.Image,
        slot: SlotMetadata,
        anchor_mode: str,
        landmarks: Optional[FaceLandmarks] = None,
    ) -> Tuple[int, int]:
        """
        Calculate (x, y) coordinates for placement.
        
        Smart placement logic:
        - If face detected: Align face to target anchor point in slot
        - If no face: Center horizontally, anchor to bottom
        """
        sticker_w, sticker_h = sticker.size
        
        # === FULL FRAME ANCHORING ===
        # If we didn't crop the photo, place it exactly at the slot's very top-left corner
        # (Assuming the slot matches the full template resolution)
        if anchor_mode == "full_frame":
            print(f"DEBUG Placement: 'full_frame' anchoring. X={slot.x}, Y={slot.y}")
            return (int(slot.x), int(slot.y))
        
        # === BOTTOM-CENTER ANCHORING ('none' mode or no face) ===
        if anchor_mode == "none" or not landmarks or landmarks.confidence < 0.5:
            # Center horizontally in the slot
            final_x = slot.x + (slot.width - sticker_w) // 2
            
            # Anchor to bottom of the slot with small padding
            bottom_padding = int(slot.height * 0.02)
            final_y = slot.y + slot.height - sticker_h - bottom_padding
            
            print(f"DEBUG Placement: Bottom-anchor mode. X={final_x}, Y={final_y}")
            return (int(final_x), int(final_y))
            
        # === FACE-AWARE ANCHORING (when face is detected and mode != none) ===
        if landmarks and landmarks.confidence > 0.5:
            # Where in the SLOT should the face go?
            # Use slot's anchor config, or default to center-upper-third
            target_x = self.resolve_anchor_to_pixels(slot.anchor_target_x, slot.width)
            target_y = self.resolve_anchor_to_pixels(slot.anchor_target_y, slot.height)
            
            if target_x is None: 
                target_x = slot.width // 2  # Center horizontally
            if target_y is None: 
                target_y = int(slot.height * 0.30)  # Face in upper third
            
            # Where is the face in the STICKER?
            face_x = landmarks.center_x
            face_y = landmarks.eye_y if anchor_mode == "eyes" else landmarks.center_y
            
            # Calculate position so face aligns with target
            final_x = slot.x + target_x - face_x
            final_y = slot.y + target_y - face_y
            
            # Clamp to keep sticker reasonably within slot 
            # Allow some overflow (20%) but not too much
            min_x = slot.x - int(sticker_w * 0.2)
            max_x = slot.x + slot.width - int(sticker_w * 0.8)
            min_y = slot.y - int(sticker_h * 0.1)
            max_y = slot.y + slot.height - int(sticker_h * 0.5)
            
            final_x = max(min_x, min(max_x, final_x))
            final_y = max(min_y, min(max_y, final_y))
            
            print(f"DEBUG Placement: Face-anchor mode. target=({target_x},{target_y}), face=({face_x},{face_y}), final=({final_x},{final_y})")
            return (int(final_x), int(final_y))
        
        return (slot.x + (slot.width - sticker_w) // 2, slot.y + slot.height - sticker_h)

    def _draw_magazine_text(
        self,
        canvas: Image.Image,
        text: str,
        cfg: 'MagazineTextConfig',
        res_multiplier: float,
    ) -> None:
        """
        Draw a single line of text on the canvas in-place using Pillow ImageDraw.

        All native-pixel coordinates in cfg are scaled by res_multiplier so the
        text renders correctly regardless of the canvas upscaling applied in
        compose_final.

        Args:
            canvas       — The RGBA canvas to draw onto (mutated in-place)
            text         — The string to draw (name or designation)
            cfg          — MagazineTextConfig loaded from the template JSON
            res_multiplier — The same multiplier used to scale the canvas in compose_final
        """
        from PIL import ImageDraw, ImageFont

        if not text or not text.strip():
            return

        # Apply uppercase if configured
        display_text = text.upper() if cfg.uppercase else text

        # Scale coordinates to the upscaled canvas space
        x = int(cfg.x * res_multiplier)
        y = int(cfg.y * res_multiplier)
        font_size = int(cfg.font_size * res_multiplier)
        max_width = int(cfg.max_width * res_multiplier) if cfg.max_width > 0 else 0

        # Load font
        font = None
        if cfg.font_path and os.path.exists(cfg.font_path):
            try:
                font = ImageFont.truetype(cfg.font_path, font_size)
            except Exception as e:
                print(f"WARNING: Could not load font {cfg.font_path}: {e}. Using default.", flush=True)

        if font is None:
            # Pillow built-in default — no TTF needed, always available
            # Note: default font ignores size; this is a fallback only
            try:
                # Try to load a common system font as a better fallback
                for fallback in [
                    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
                    "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
                    "C:/Windows/Fonts/arial.ttf",
                ]:
                    if os.path.exists(fallback):
                        font = ImageFont.truetype(fallback, font_size)
                        break
            except Exception:
                pass

        if font is None:
            font = ImageFont.load_default()

        # Parse colour (supports "#RRGGBB" and named colours like "white")
        try:
            from PIL import ImageColor
            rgb = ImageColor.getrgb(cfg.color)
            colour_rgba = rgb + (255,) if len(rgb) == 3 else rgb
        except Exception:
            colour_rgba = (255, 255, 255, 255)

        draw = ImageDraw.Draw(canvas)

        # If max_width is set, truncate text to fit (single line only — no wrapping)
        if max_width > 0:
            # Linear pruning: trim one char at a time until it fits
            truncated = False
            while len(display_text) > 1:
                bbox = draw.textbbox((0, 0), display_text, font=font)
                text_w = bbox[2] - bbox[0]
                if text_w <= max_width:
                    break
                display_text = display_text[:-1]
                truncated = True
            if truncated and len(display_text) > 3:
                display_text = display_text[:-1] + '…'  # Add ellipsis when truncated

        # Alignment offset
        if cfg.align in ("center", "right"):
            bbox = draw.textbbox((0, 0), display_text, font=font)
            text_w = bbox[2] - bbox[0]
            if cfg.align == "center":
                ref_w = max_width if max_width > 0 else (canvas.width - x)
                x = x + (ref_w - text_w) // 2
            else:  # right
                ref_w = max_width if max_width > 0 else (canvas.width - x)
                x = x + ref_w - text_w

        draw.text((x, y), display_text, font=font, fill=colour_rgba)
        print(f"DEBUG Magazine Text: drew '{display_text}' at ({x},{y}) size={font_size}", flush=True)

    def compose_final(
        self,
        template_path: Optional[str],
        stickers: List[Dict], # List of {"image": PIL, "landmarks": FaceLandmarks}
        template_meta: TemplateMetadata,
        processing_mode: str = "sticker",
        user_position: Optional[Dict] = None,
        fg_template_path: Optional[str] = None,  # Magazine mode: foreground overlay
        magazine_name: str = "",           # Magazine mode: person's name
        magazine_designation: str = "",    # Magazine mode: person's designation
    ) -> Image.Image:
        """
        Main entry point for final sticker-style composition.
        """
        from PIL import ImageDraw
        
        # Smart Auto-Upscaling:
        # If the template is defined at low resolution (e.g. 400px), we scale the entire
        # process up to a target resolution (e.g. 1080p min dimension) so the high-res 
        # webcam photos are not crushed into thumbnail size.
        res_multiplier = max(1.0, 1080 / min(template_meta.width, template_meta.height))
        
        canvas_w = int(template_meta.width * res_multiplier)
        canvas_h = int(template_meta.height * res_multiplier)
        
        print(f"DEBUG Compose: Scaling canvas {template_meta.width}x{template_meta.height} -> {canvas_w}x{canvas_h} (multiplier={res_multiplier:.2f})", flush=True)
        
        # 1. Start with background or transparent canvas
        # Frame mode usually needs a solid white background behind the photo
        bg_color = (255, 255, 255, 255) if processing_mode == "frame" else (255, 255, 255, 0)
        canvas = Image.new("RGBA", (canvas_w, canvas_h), bg_color)
        
        # For sticker "background" mode, place template first (behind sticker)
        # Magazine mode also starts with a BG layer behind the user cutout
        _bg_check = processing_mode in ("sticker", "pre_extracted") and template_meta.composite_mode in ("background", "magazine")
        print(f"DEBUG Compose: background check: mode={processing_mode}, composite_mode={template_meta.composite_mode}, path={template_path}, exists={os.path.exists(template_path) if template_path else 'N/A'}, will_composite={_bg_check and bool(template_path) and (os.path.exists(template_path) if template_path else False)}", flush=True)
        if _bg_check and template_path and os.path.exists(template_path):
            template = _get_resized_template(template_path, canvas_w, canvas_h)
            print(f"DEBUG Compose: Template loaded: size={template.size}, mode={template.mode}, extrema={template.getextrema()}", flush=True)
            canvas = Image.alpha_composite(canvas, template)
            # Verify canvas now has template content
            print(f"DEBUG Compose: Canvas after template composite: extrema={canvas.getextrema()}", flush=True)
        
        # Sort slots (original slots, not scaled yet)
        sorted_slots_meta = sorted(template_meta.slots, key=lambda s: s.z_index)
        
        fit_mode = "cover" if processing_mode == "frame" else "contain"
        
        # Prepare stickers with their corresponding slots
        # The `stickers` list might not be sorted by z_index, so we need to match them.
        # Assuming `stickers` are provided in the order they should fill `sorted_slots_meta`.
        for i, sticker_data_input in enumerate(stickers):
            if i >= len(sorted_slots_meta):
                break # No more slots for this sticker
            
            original_slot = sorted_slots_meta[i]
            
            # Create a virtual scaled slot so calculate_placement works in the new resolution
            s_slot = SimpleNamespace(
                slot_id=original_slot.slot_id,
                width=int(original_slot.width * res_multiplier),
                height=int(original_slot.height * res_multiplier),
                x=int(original_slot.x * res_multiplier),
                y=int(original_slot.y * res_multiplier),
                # Ratios (<=1.0) pass through as-is; resolve_anchor_to_pixels multiplies by the already-scaled slot dimension.
                # Absolute pixels (>1.0) must be scaled by res_multiplier to match the upscaled canvas.
                anchor_target_x=(original_slot.anchor_target_x * res_multiplier if original_slot.anchor_target_x is not None and original_slot.anchor_target_x > 1.0 else original_slot.anchor_target_x),
                anchor_target_y=(original_slot.anchor_target_y * res_multiplier if original_slot.anchor_target_y is not None and original_slot.anchor_target_y > 1.0 else original_slot.anchor_target_y),
                z_index=original_slot.z_index,
                desired_face_ratio=original_slot.desired_face_ratio,
                min_zoom=original_slot.min_zoom,
                max_zoom=original_slot.max_zoom,
                _temp_anchor_mode=getattr(original_slot, '_temp_anchor_mode', template_meta.anchor_mode) # Pass through
            )

            sticker_img = sticker_data_input["image"]
            landmarks = sticker_data_input.get("landmarks")
            
            # Scale landmarks if present
            landmarks_scaled = None
            if landmarks:
                landmarks_scaled = FaceLandmarks(
                    center_x=int(landmarks.center_x * res_multiplier),
                    center_y=int(landmarks.center_y * res_multiplier),
                    eye_y=int(landmarks.eye_y * res_multiplier),
                    face_height=int(landmarks.face_height * res_multiplier),
                    confidence=landmarks.confidence
                )

            # Apply Filter if in sticker/pre_extracted mode
            if processing_mode in ("sticker", "pre_extracted") and hasattr(template_meta, 'sticker_filter'):
                sticker_img = self.apply_sticker_filter(sticker_img, template_meta.sticker_filter)
            
            img_w_orig, img_h_orig = sticker_img.size

            # Fit sticker to slot (scaled)
            sticker_scaled = self.fit_sticker_to_slot(
                sticker_img,
                s_slot, # Use scaled slot
                fit_mode,
                face_height=landmarks_scaled.face_height if landmarks_scaled else None # Use scaled face height
            )

            # Calculate Placement
            if user_position:
                user_scale = user_position.get('scale', 1.0)
                user_x = user_position.get('x', 0)
                user_y = user_position.get('y', 0)
                editor_width = user_position.get('editorWidth', 400)
                sticker_width = user_position.get('stickerWidth', 0)
                
                # The scale factor (sf) converts frontend editor pixels directly to backend canvas pixels
                # Multiplied by res_multiplier because the backend canvas is now larger than the template meta
                sf = (template_meta.width * res_multiplier / editor_width) if editor_width > 0 else res_multiplier
                
                if sticker_width > 0:
                    # Explicit exact pixel width from the frontend DOM layout
                    base_frontend_w = sticker_width
                    base_frontend_h = base_frontend_w / (img_w_orig / img_h_orig) if img_w_orig > 0 else 0
                else:
                    # Fallback if frontend didn't pass it
                    editor_height = editor_width * (template_meta.height / template_meta.width)
                    img_ratio = img_w_orig / img_h_orig if img_h_orig > 0 else 1.0
                    box_ratio = template_meta.width / template_meta.height
                    
                    if img_ratio > box_ratio:
                        base_frontend_w = editor_width
                        base_frontend_h = editor_width / img_ratio
                    else:
                        base_frontend_h = editor_height
                        base_frontend_w = editor_height * img_ratio
                
                # Scale up to backend size * user scale multiplier
                final_w = int(base_frontend_w * user_scale * sf)
                final_h = int(base_frontend_h * user_scale * sf)
                
                if final_w > 0 and final_h > 0:
                    sticker_scaled = sticker_img.resize((final_w, final_h), Image.Resampling.LANCZOS)
                else:
                    sticker_scaled = sticker_img

                # Placement: Frontend translate(x,y) moves the image from its center rest position.
                # Center of the backend canvas
                cx = canvas_w / 2
                cy = canvas_h / 2
                
                # Apply translation scaled up to backend space
                final_cx = cx + (user_x * sf)
                final_cy = cy + (user_y * sf)
                
                # Pillow uses top-left coordinates for pasting
                x = int(final_cx - (final_w / 2))
                y = int(final_cy - (final_h / 2))
                
            elif template_meta.anchor_mode == "full_frame":
                x, y = 0, 0
                print(f"DEBUG Compose: 'full_frame' active. Forcing placement to (0,0)")
            else:
                x, y = self.calculate_placement(
                    sticker_scaled, 
                    s_slot, # Use scaled slot
                    template_meta.anchor_mode, 
                    landmarks_scaled # Use scaled landmarks
                )

            # Paste photo onto canvas, clipped to slot bounds
            # (Critical for WTM where photo_slot != full canvas. No-op when slot == canvas.)
            print(f"DEBUG Compose: Sticker placement: sticker_scaled={sticker_scaled.size}, paste_at=({x},{y}), slot=({s_slot.x},{s_slot.y},{s_slot.width},{s_slot.height}), canvas={canvas.size}", flush=True)
            sx, sy = s_slot.x, s_slot.y
            sw, sh = s_slot.width, s_slot.height
            clip_l = max(0, sx - x)
            clip_t = max(0, sy - y)
            clip_r = min(sticker_scaled.width, sx + sw - x)
            clip_b = min(sticker_scaled.height, sy + sh - y)
            print(f"DEBUG Compose: Clip bounds: l={clip_l}, t={clip_t}, r={clip_r}, b={clip_b}", flush=True)
            if clip_r > clip_l and clip_b > clip_t:
                clipped = sticker_scaled.crop((clip_l, clip_t, clip_r, clip_b))
                print(f"DEBUG Compose: Clipped sticker: size={clipped.size}, pasting at ({x + clip_l},{y + clip_t})", flush=True)
                canvas.paste(clipped, (x + clip_l, y + clip_t), clipped)
            else:
                print(f"DEBUG Compose: WARNING — clip bounds invalid, pasting unclipped", flush=True)
                canvas.paste(sticker_scaled, (x, y), sticker_scaled)


        # --- MAGAZINE MODE: FG overlay on top of user cutout ---
        # BG was already placed behind the sticker in the _bg_check above.
        # Now place the foreground (title, text, design elements) on top.
        if template_meta.composite_mode == "magazine":
            # Step 1 — composite FG PNG over the user cutout
            if fg_template_path and os.path.exists(fg_template_path):
                # Load FG at its NATIVE dimensions (the FG may be intentionally smaller
                # than the BG to accommodate an fg_offset without edge clipping).
                # Only scale by res_multiplier for high-res canvas upscaling — do NOT
                # force-resize to (canvas_w, canvas_h), or the admin-configured
                # margin will be destroyed and the right/bottom will be clipped.
                fg_native = _load_template_image(fg_template_path)
                if res_multiplier != 1.0:
                    fg = _get_resized_template(
                        fg_template_path,
                        int(fg_native.width * res_multiplier),
                        int(fg_native.height * res_multiplier),
                    )
                else:
                    fg = fg_native

                fg_off = template_meta.fg_offset or {}
                ox = int(fg_off.get('x', 0) * res_multiplier)
                oy = int(fg_off.get('y', 0) * res_multiplier)

                # Always use a layer: FG is generally smaller than canvas, so we can't
                # alpha_composite directly (PIL requires matching sizes).
                fg_layer = Image.new('RGBA', (canvas_w, canvas_h), (0, 0, 0, 0))
                fg_layer.paste(fg, (ox, oy), fg)
                canvas = Image.alpha_composite(canvas, fg_layer)
                print(f"DEBUG Compose: Magazine FG overlay applied: {os.path.basename(fg_template_path)} fg_size={fg.size} offset=({ox},{oy}) canvas=({canvas_w},{canvas_h})", flush=True)
            else:
                print(f"DEBUG Compose: Magazine mode but no FG path or file missing: {fg_template_path}", flush=True)

            # Text drawing is handled below (shared with all composite modes)

        # --- FRAME MODE: Overlay frame ON TOP of photo ---
        # The frame PNG already has transparent cutouts where the photo shows through.
        # No hole-punching needed — just composite the frame directly on top.
        if processing_mode == "frame" and template_path and os.path.exists(template_path):
            print(f"DEBUG Compose: Frame mode — overlaying frame on top of photo", flush=True)
            template = _get_resized_template(template_path, canvas_w, canvas_h)
            canvas = Image.alpha_composite(canvas, template)
        
        # --- STICKER MODE with overlay: Place template on top ---
        elif processing_mode in ("sticker", "pre_extracted") and template_meta.composite_mode == "overlay" and template_path and os.path.exists(template_path):
            template = _get_resized_template(template_path, canvas_w, canvas_h)
            
            # If template has no transparency, treat white as transparent
            has_transparency = False
            if template.mode == "RGBA":
                extrema = template.getextrema()
                if len(extrema) >= 4 and extrema[3][0] < 255:
                    has_transparency = True
                    
            if not has_transparency:
                t_mask = time.perf_counter()
                print("DEBUG Compose: Template has no transparency, converting white to alpha (FAST)", flush=True)
                # Important: copy from cache before mutating
                template = template.copy().convert("RGBA")
                gray = template.convert("L")
                mask = gray.point(lambda x: 0 if x > 240 else 255, mode='1').convert("L")
                template.putalpha(mask)
                print(f"PERF:   white→alpha:   {time.perf_counter() - t_mask:.2f}s", flush=True)
            
            t_comp = time.perf_counter()
            canvas = Image.alpha_composite(canvas, template)
            print(f"PERF:   alpha_comp:    {time.perf_counter() - t_comp:.2f}s", flush=True)

        # --- Text overlays: fire for any composite mode (magazine, WTM background, sticker) ---
        if magazine_name and template_meta.name_text:
            self._draw_magazine_text(
                canvas=canvas,
                text=magazine_name,
                cfg=template_meta.name_text,
                res_multiplier=res_multiplier,
            )
        elif magazine_name:
            print("DEBUG Compose: magazine_name provided but name_text config missing in template JSON", flush=True)

        if magazine_designation and template_meta.designation_text:
            self._draw_magazine_text(
                canvas=canvas,
                text=magazine_designation,
                cfg=template_meta.designation_text,
                res_multiplier=res_multiplier,
            )
        elif magazine_designation:
            print("DEBUG Compose: magazine_designation provided but designation_text config missing in template JSON", flush=True)

        return canvas


compose_service = ComposeService()
