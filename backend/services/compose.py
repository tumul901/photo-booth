"""
Image Compositing Service (SmartFit v1 + Face Anchor v1)
========================================================
Handles sticker placement with booth-grade accuracy.

Pipeline:
1. Crop to Alpha BBox (remove transparent padding)
2. Fit to Slot (using desiredFaceRatio if available)
3. Calculate Placement (using Face Landmarks if available)
"""

from PIL import Image, ImageOps
from typing import Tuple, Optional, Dict, List, Union
from dataclasses import dataclass
import json
import os
from services.face_service import FaceLandmarks

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
                    template_id=data.get("id", template_id),
                    name=data.get("name", "Unnamed"),
                    png_path=data.get("png_path", data.get("pngUrl", "")),
                    slots=slots,
                    anchor_mode=data.get("anchorMode", "bbox_center"),
                    width=dimensions.get("width", data.get("width", 1200)),
                    height=dimensions.get("height", data.get("height", 1600)),
                    template_type=data.get("templateType", "sticker"),
                    composite_mode=data.get("compositeMode", "overlay"),
                )
            except Exception as e:
                print(f"Error parse template {json_path}: {e}")
                continue
    return None

class ComposeService:
    """
    Service for compositing stickers onto templates with SmartFit logic.
    """
    
    def crop_to_alpha_bbox(self, sticker: Image.Image) -> Image.Image:
        """
        Crop image to the bounding box of non-transparent pixels.
        Ensures we are working with the actual subject, not empty space.
        """
        if sticker.mode != "RGBA":
            sticker = sticker.convert("RGBA")
        
        alpha = sticker.getchannel("A")
        bbox = alpha.getbbox()
        
        if bbox:
            return sticker.crop(bbox)
        
        # If image is fully transparent, return 1x1 empty pixel to avoid crashes
        return Image.new("RGBA", (1, 1), (0, 0, 0, 0))

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
        
        print(f"DEBUG SmartFit: Input sticker={sticker_w}×{sticker_h}, slot={slot.width}×{slot.height}, mode={fit_mode}")
            
        # Logic 1: Face Size Normalization
        if face_height and slot.desired_face_ratio:
            target_face_h = slot.height * slot.desired_face_ratio
            scale = target_face_h / face_height
            
            # Clamp scale
            scale = max(slot.min_zoom, min(slot.max_zoom, scale))
            
            new_w = int(sticker_w * scale)
            new_h = int(sticker_h * scale)
            
            print(f"DEBUG SmartFit: Face-based scaling. Ratio={slot.desired_face_ratio}, Scale={scale:.2f}, output={new_w}×{new_h}")
            return sticker.resize((new_w, new_h), Image.Resampling.LANCZOS)

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
        return sticker.resize((new_w, new_h), Image.Resampling.LANCZOS)

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
        
        # === FACE-AWARE ANCHORING (when face is detected) ===
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
        
        # === BOTTOM-CENTER ANCHORING (no face detected) ===
        # Center horizontally
        final_x = slot.x + (slot.width - sticker_w) // 2
        
        # Anchor to bottom with small padding
        bottom_padding = int(slot.height * 0.02)
        final_y = slot.y + slot.height - sticker_h - bottom_padding
        
        # Don't go above slot top
        final_y = max(slot.y, final_y)
        
        print(f"DEBUG Placement: Bottom-anchor mode. X={final_x}, Y={final_y}")
        return (int(final_x), int(final_y))

    def compose_final(
        self,
        template_path: Optional[str],
        stickers: List[Dict], # List of {"image": PIL, "landmarks": FaceLandmarks}
        template_meta: TemplateMetadata,
        processing_mode: str = "sticker",
        user_position: Optional[Dict] = None,
    ) -> Image.Image:
        """
        Main composition loop.
        
        Composite Modes:
        - "overlay": Template placed ON TOP of sticker (template needs transparency/cutouts)
        - "background": Template placed BEHIND sticker (for branded backgrounds)
        """
        # Canvas
        canvas = Image.new("RGBA", (template_meta.width, template_meta.height), (255, 255, 255, 255))
        
        # For "background" mode, place template first
        if template_meta.composite_mode == "background" and template_path and os.path.exists(template_path):
            template = Image.open(template_path).convert("RGBA")
            if template.size != (template_meta.width, template_meta.height):
                template = template.resize((template_meta.width, template_meta.height), Image.Resampling.LANCZOS)
            canvas = Image.alpha_composite(canvas, template)
        
        # Sort slots
        sorted_slots = sorted(template_meta.slots, key=lambda s: s.z_index)
        
        fit_mode = "cover" if processing_mode == "frame" else "contain"
        
        for i, slot in enumerate(sorted_slots):
            if i >= len(stickers): break
            
            sticker_data = stickers[i]
            sticker_img = sticker_data["image"]
            landmarks = sticker_data.get("landmarks")
            
            # --- Pipeline Step 1 is already done by generate.py (RemBG) ---
            
            # --- Pipeline Step 2: Tight Crop (if sticker mode) ---
            if processing_mode == "sticker":
                # Note: `generate.py` should effectively do this BEFORE detection to be safe, 
                # but if we do it here, landmarks need to be adjusted.
                # New plan: generate.py does Crop -> Detect.
                # So here `sticker_img` is ALREADY cropped.
                pass 
                
            # --- Pipeline Step 3: Fit to Slot (Scaling) ---
            # We need to scale landmarks proportionally!
            img_w_orig, img_h_orig = sticker_img.size
            
            face_h = landmarks.face_height if landmarks else None
            sticker_scaled = self.fit_sticker_to_slot(sticker_img, slot, fit_mode, face_h)
            
            # Calculate scale factor to update landmarks
            scale_factor = sticker_scaled.width / img_w_orig if img_w_orig > 0 else 1.0
            
            landmarks_scaled = None
            if landmarks:
                landmarks_scaled = FaceLandmarks(
                    center_x=int(landmarks.center_x * scale_factor),
                    center_y=int(landmarks.center_y * scale_factor),
                    eye_y=int(landmarks.eye_y * scale_factor),
                    face_height=int(landmarks.face_height * scale_factor),
                    confidence=landmarks.confidence
                )

            # --- Pipeline Step 4: Calculate Placement ---
            # If user manually positioned (Step 2 of Wiz), override logic
            if user_position:
                # Basic manual override logic (simplified for MVP)
                # We assume manual means "manual", ignore smart fit
                x, y = 0, 0 # Placeholder for complex manual logic
                # For now let's skip manual logic in this refactor to focus on AUTO
                # Re-using old logic:
                user_scale = user_position.get('scale', 1.0)
                user_x = user_position.get('x', 0)
                user_y = user_position.get('y', 0)
                
                # Apply extra user scale
                if user_scale != 1.0:
                    new_w = int(sticker_scaled.width * user_scale)
                    new_h = int(sticker_scaled.height * user_scale)
                    sticker_scaled = sticker_scaled.resize((new_w, new_h), Image.Resampling.LANCZOS)
                
                # Simple center placement + offset
                base_x = slot.x + (slot.width - sticker_scaled.width) // 2
                base_y = slot.y + (slot.height - sticker_scaled.height) // 2
                
                editor_width = user_position.get('editorWidth', 400)
                sf = template_meta.width / editor_width
                x = base_x + int(user_x * sf)
                y = base_y + int(user_y * sf)
            else:
                # AUTO PLACEMENT (The Goal)
                x, y = self.calculate_placement(
                    sticker_scaled, 
                    slot, 
                    template_meta.anchor_mode, 
                    landmarks_scaled
                )

            # --- Pipeline Step 5: Composite ---
            # Paste (safe bounds)
            # x, y can be negative, standard Paste handles it or crop?
            # PIL paste does NOT handle negative destination well for alpha composition sometimes
            # But `canvas.paste(im, box, mask)` works.
            
            # Since we use alpha mask (sticker itself), it should be fine.
            canvas.paste(sticker_scaled, (x, y), sticker_scaled)

        # Template Overlay (only for "overlay" mode - template has cutouts)
        if template_meta.composite_mode == "overlay" and template_path and os.path.exists(template_path):
             template = Image.open(template_path).convert("RGBA")
             if template.size != (template_meta.width, template_meta.height):
                 template = template.resize((template_meta.width, template_meta.height), Image.Resampling.LANCZOS)
             canvas = Image.alpha_composite(canvas, template)
             
        return canvas

compose_service = ComposeService()
