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
from io import BytesIO
from types import SimpleNamespace
from PIL import Image, ImageOps, ImageFilter, ImageEnhance
from typing import Tuple, Optional, Dict, List, Union
from dataclasses import dataclass
from functools import lru_cache
import json
from services.face_service import FaceLandmarks


@lru_cache(maxsize=8)
def _load_template_image(path: str) -> Image.Image:
    """Cache template PNGs in memory to avoid repeated disk I/O."""
    print(f"INFO: Loading template image into cache: {os.path.basename(path)}", flush=True)
    return Image.open(path).convert("RGBA")

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
class TemplateMetadata:
    """Full template configuration."""
    template_id: str
    name: str
    png_path: str
    slots: List[SlotMetadata]
    anchor_mode: str  # face_center, eyes, bbox_center, none
    width: int
    height: int
    template_type: str = "sticker" # frame, sticker
    composite_mode: str = "overlay"  # "overlay" = template on top, "background" = template behind sticker
    sticker_filter: str = "none"  # "none", "bw", "sketch"

def clear_template_cache():
    """Clear in-memory caches when templates are updated."""
    load_template_metadata.cache_clear()
    _load_template_image.cache_clear()

@lru_cache(maxsize=32)
def load_template_metadata(template_id: str, templates_dir: Optional[str] = None) -> Optional[TemplateMetadata]:
    """Load template metadata from JSON file."""
    if templates_dir is None:
        project_root = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
        templates_dir = os.path.join(project_root, "templates")
    
    # Try multiple potential filenames
    json_files = [
        os.path.join(templates_dir, f"{template_id}.json"),
        os.path.join(templates_dir, os.path.basename(template_id) + ".json"),
    ]
    
    for json_path in json_files:
        if os.path.exists(json_path):
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
                return TemplateMetadata(
                    template_id=data.get("templateId", data.get("id", template_id)),
                    name=data.get("name", "Unnamed"),
                    png_path=data.get("png_path", data.get("pngUrl", "")),
                    slots=slots,
                    anchor_mode=data.get("anchorMode", "bbox_center"),
                    width=dimensions.get("width", data.get("width", 1200)),
                    height=dimensions.get("height", data.get("height", 1600)),
                    template_type=data.get("templateType", data.get("mode", "sticker")),
                    composite_mode=data.get("compositeMode", "overlay"),
                    sticker_filter=data.get("stickerFilter", "none"),
                )
            except Exception as e:
                print(f"Error parse template {json_path}: {e}")
                continue
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

    def compose_final(
        self,
        template_path: Optional[str],
        stickers: List[Dict], # List of {"image": PIL, "landmarks": FaceLandmarks}
        template_meta: TemplateMetadata,
        processing_mode: str = "sticker",
        user_position: Optional[Dict] = None,
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
        canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 0))
        
        # For sticker "background" mode, place template first (behind sticker)
        if processing_mode in ("sticker", "pre_extracted") and template_meta.composite_mode == "background" and template_path and os.path.exists(template_path):
            template = _load_template_image(template_path).copy()
            if template.size != (canvas_w, canvas_h):
                template = template.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
            canvas = Image.alpha_composite(canvas, template)
        
        # Sort slots (original slots, not scaled yet)
        sorted_slots_meta = sorted(template_meta.slots, key=lambda s: s.z_index)
        
        fit_mode = "cover" if processing_mode == "frame" else "contain"
        
        # Prepare stickers with their corresponding slots
        # The `stickers` list might not be sorted by z_index, so we need to match them.
        # Assuming `stickers` are provided in the order they should fill `sorted_slots_meta`.
        processed_stickers = []
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
                anchor_target_x=original_slot.anchor_target_x, # These are ratios/absolute, not scaled yet
                anchor_target_y=original_slot.anchor_target_y,
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

            # Paste photo onto canvas
            canvas.paste(sticker_scaled, (x, y), sticker_scaled)


        # --- FRAME MODE: Always place frame ON TOP with holes at slot positions ---
        if processing_mode == "frame" and template_path and os.path.exists(template_path):
            print(f"DEBUG Compose: Frame mode — placing frame ON TOP with slot cutouts (scaled)", flush=True)
            template = _load_template_image(template_path).copy()
            if template.size != (canvas_w, canvas_h):
                template = template.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
            
            # Punch transparent holes at slot positions so photo shows through
            mask = template.getchannel("A").copy()
            draw = ImageDraw.Draw(mask)
            for slot in sorted_slots_meta: # Iterate original slots, but scale coordinates for drawing
                draw.rectangle(
                    [int(slot.x * res_multiplier), int(slot.y * res_multiplier), 
                     int((slot.x + slot.width) * res_multiplier), int((slot.y + slot.height) * res_multiplier)],
                    fill=0  # Fully transparent
                )
            template.putalpha(mask)
            canvas = Image.alpha_composite(canvas, template)
        
        # --- STICKER MODE with overlay: Place template on top ---
        elif processing_mode in ("sticker", "pre_extracted") and template_meta.composite_mode == "overlay" and template_path and os.path.exists(template_path):
            template = _load_template_image(template_path).copy()
            
            # If template has no transparency (e.g., JPEG or opaque PNG), treat white as transparent
            # so the sticker underneath can show through
            has_transparency = False
            if template.mode == "RGBA":
                extrema = template.getextrema()
                if extrema[3][0] < 255:  # Min alpha is < 255
                    has_transparency = True
            
            if not has_transparency:
                print("DEBUG Compose: Template has no transparency, converting white to alpha", flush=True)
                template = template.convert("RGBA")
                data = template.getdata()
                new_data = []
                for item in data:
                    # R, G, B > 240 is considered "white enough" to be transparent
                    if item[0] > 240 and item[1] > 240 and item[2] > 240:
                        new_data.append((255, 255, 255, 0))
                    else:
                        new_data.append(item)
                template.putdata(new_data)
                
            if template.size != (template_meta.width, template_meta.height):
                template = template.resize((template_meta.width, template_meta.height), Image.Resampling.BICUBIC)
            canvas = Image.alpha_composite(canvas, template)
             
        return canvas

compose_service = ComposeService()
