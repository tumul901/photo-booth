"""
Generate API Endpoint
=====================
Handles photo upload, background removal, and template compositing.
"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel
from typing import Optional, List
from PIL import Image
from io import BytesIO
import os
import uuid
import json

from services.rembg_service import rembg_service
from services.compose import compose_service, load_template_metadata, TemplateMetadata, SlotMetadata
from services.face_service import face_service
from services.storage_service import storage_service
from services.stats_service import stats_service

router = APIRouter()

# Base paths (relative to project root, not backend folder)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
TEMPLATES_DIR = os.path.join(PROJECT_ROOT, "templates")
OUTPUTS_DIR = os.path.join(PROJECT_ROOT, "outputs")

# Ensure outputs directory exists
os.makedirs(OUTPUTS_DIR, exist_ok=True)


class SlotAssignment(BaseModel):
    """Assignment of a photo to a specific template slot."""
    slot_id: str
    photo_index: int = 0


class GenerateResponse(BaseModel):
    """Response from the generate endpoint."""
    success: bool
    output_url: Optional[str] = None
    download_url: Optional[str] = None
    output_id: Optional[str] = None
    error: Optional[str] = None
    processing_mode_used: Optional[str] = None


@router.post("/generate", response_model=GenerateResponse)
async def generate_composite(
    template_id: str = Form(...),
    photos: List[UploadFile] = File(...),
    slot_assignments: Optional[str] = Form(None),
    processing_mode: str = Form("sticker"),  # "sticker" (remove bg) or "frame" (no bg removal)
    photo_position: Optional[str] = Form(None),  # JSON: {"x", "y", "scale"} from editor
):
    """
    Generate a composited photo from uploaded image(s) and a template.
    
    Processing Modes:
    - "sticker" (default): Remove background, create sticker, place on template
    - "frame": Place photo directly inside frame without bg removal
    
    Flow (SmartFit v1):
    1. Load Template Metdata
    2. For each photo:
       - Remove BG (if sticker mode)
       - Crop to Alpha BBox (IMPORTANT: Do this BEFORE detection)
       - Detect Face Landmarks (on Cropped Sticker)
    3. Composite (using aligned landmarks)
    """
    print(f"DEBUG: Processing mode received: {processing_mode}", flush=True)
    
    try:
        # Validate inputs
        if not photos:
            raise HTTPException(status_code=400, detail="At least one photo is required")
        
        # Validate processing mode
        if processing_mode not in ["sticker", "frame"]:
            processing_mode = "sticker"
        
        # Load template metadata
        template_meta = load_template_metadata(template_id, TEMPLATES_DIR)
        
        if not template_meta:
            # Create a default template if none found (Legacy fallback)
            template_meta = TemplateMetadata(
                template_id=template_id,
                name="Default Template",
                png_path="",
                slots=[SlotMetadata(
                    slot_id="main",
                    x=100,
                    y=100,
                    width=1000,
                    height=1000,
                    anchor_target_x=500,
                    anchor_target_y=400,
                    z_index=0,
                )],
                anchor_mode="bbox_center",
                width=1200,
                height=1200,
            )
        
        # Process each photo
        processed_stickers = [] # List of {"image": PIL, "landmarks": data}
        
        for photo in photos:
            # Read photo bytes
            photo_bytes = await photo.read()
            
            sticker_image = None
            landmarks = None
            
            if processing_mode == "sticker":
                # 1. Remove background
                sticker_image = await rembg_service.remove_background(photo_bytes)
                
                # 2. Crop logic (Robust Tight Crop)
                # We crop strictly to alpha bbox to remove empty space
                sticker_image = compose_service.crop_to_alpha_bbox(sticker_image)
                
                # 3. Face Detection
                # Must be run on the cropped sticker to get correct relative coordinates
                try:
                    landmarks = face_service.detect_landmarks(sticker_image)
                    if landmarks:
                        print(f"DEBUG: Face detected: {landmarks}", flush=True)
                    else:
                        print("DEBUG: No face detected in sticker", flush=True)
                except Exception as e:
                    print(f"DEBUG: Face detection failed: {e}", flush=True)

            else:
                # Frame mode: simple load
                sticker_image = Image.open(BytesIO(photo_bytes)).convert("RGBA")
                # No cropping, no detection for frame mode usually (unless we want face aware frame?)
                # For now, keep frame mode simple.
            
            processed_stickers.append({
                "image": sticker_image,
                "landmarks": landmarks
            })
        
        # Parse slot assignments if provided
        parsed_assignments = None
        if slot_assignments:
            try:
                assignments_list = json.loads(slot_assignments)
                parsed_assignments = {
                    a["slot_id"]: a["photo_index"] 
                    for a in assignments_list
                }
            except (json.JSONDecodeError, KeyError):
                pass
        
        # Parse photo position from editor
        user_position = None
        if photo_position:
            try:
                user_position = json.loads(photo_position)
            except json.JSONDecodeError:
                pass
        
        # Compose final image
        template_path = os.path.join(TEMPLATES_DIR, template_meta.png_path) if template_meta.png_path else None
        
        final_image = compose_service.compose_final(
            template_path=template_path,
            stickers=processed_stickers, # Now passing dicts
            template_meta=template_meta,
            processing_mode=processing_mode,
            user_position=user_position,
        )
        
        # Generate output ID and save
        output_id = f"{template_id[:8]}-{uuid.uuid4().hex[:8]}"
        output_filename = f"{output_id}.png"
        output_path = os.path.join(OUTPUTS_DIR, output_filename)
        
        # Save the image
        final_image.save(output_path, "PNG", optimize=True)
        
        # Track stats
        stats_service.increment_generation(processing_mode, template_id)
        
        # Generate URLs
        base_url = "http://localhost:8000"
        download_url = f"{base_url}/api/download/{output_id}"
        share_url = f"{base_url}/api/share/{output_id}"
        
        return GenerateResponse(
            success=True,
            output_id=output_id,
            output_url=share_url,
            download_url=download_url,
            error=None,
            processing_mode_used=processing_mode,
        )
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        return GenerateResponse(
            success=False,
            error=str(e),
        )


@router.get("/download/{output_id}")
async def download_output(output_id: str):
    """Download a generated output image."""
    output_path = os.path.join(OUTPUTS_DIR, f"{output_id}.png")
    
    if not os.path.exists(output_path):
        raise HTTPException(status_code=404, detail="Output not found")
    
    return FileResponse(
        output_path,
        media_type="image/png",
        filename=f"photobooth-{output_id}.png",
    )


@router.get("/share/{output_id}")
async def get_share_info(output_id: str):
    """Get share information for a generated output."""
    output_path = os.path.join(OUTPUTS_DIR, f"{output_id}.png")
    
    if not os.path.exists(output_path):
        raise HTTPException(status_code=404, detail="Output not found")
    
    base_url = "http://localhost:8000"
    return {
        "output_id": output_id,
        "download_url": f"{base_url}/api/download/{output_id}",
        "image_url": f"{base_url}/api/download/{output_id}",
        "share_url": f"{base_url}/api/share/{output_id}",
    }


@router.get("/templates")
async def list_templates():
    """List all available templates with their metadata."""
    templates = []
    
    print(f"DEBUG: Scanning templates dir: {TEMPLATES_DIR}", flush=True)
    if os.path.exists(TEMPLATES_DIR):
        for filename in os.listdir(TEMPLATES_DIR):
            if filename.endswith(".json") and not filename.startswith("template_schema"):
                try:
                    t_id = filename.replace(".json", "")
                    meta = load_template_metadata(t_id, TEMPLATES_DIR)
                    if meta:
                        templates.append({
                            "templateId": meta.template_id,
                            "name": meta.name,
                            "templateType": meta.template_type,
                            "slotCount": len(meta.slots),
                            "anchorMode": meta.anchor_mode,
                        })
                    else:
                        print(f"DEBUG: Failed to load metadata for {filename}", flush=True)
                except Exception as e:
                    print(f"DEBUG: Error loading template {filename}: {e}", flush=True)
    else:
        print("DEBUG: Templates dir does not exist!", flush=True)
    
    print(f"DEBUG: Found {len(templates)} templates", flush=True)
    return {"templates": templates}


@router.get("/templates/{template_id}/image")
async def get_template_image(template_id: str):
    """Serve the frame PNG for a template (used for editor preview)."""
    meta = load_template_metadata(template_id, TEMPLATES_DIR)
    
    if not meta:
        raise HTTPException(status_code=404, detail="Template not found")
    
    png_path = os.path.join(TEMPLATES_DIR, meta.png_path)
    if not os.path.exists(png_path):
        raise HTTPException(status_code=404, detail="Template image not found")
    
    return FileResponse(
        png_path,
        media_type="image/png",
        filename=f"{template_id}.png"
    )


@router.get("/output/{output_id}")
async def get_output(output_id: str):
    """Retrieve a previously generated output by ID."""
    output_path = os.path.join(OUTPUTS_DIR, f"{output_id}.png")
    
    if not os.path.exists(output_path):
        raise HTTPException(status_code=404, detail="Output not found")
    
    base_url = "http://localhost:8000"
    return {
        "output_id": output_id,
        "download_url": f"{base_url}/api/download/{output_id}",
        "share_url": f"{base_url}/api/share/{output_id}",
        "template_id": output_id.split("-")[0] if "-" in output_id else "unknown",
    }
