"""
Generate API Endpoint
=====================
Handles photo upload, background removal, and template compositing.
"""

from fastapi import APIRouter, UploadFile, File, Form, HTTPException
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, Response
from pydantic import BaseModel
from typing import Optional, List
from PIL import Image
from io import BytesIO
import os
import uuid
import json
import time

from config import settings
from services.rembg_service import rembg_service
from services.compose import compose_service, load_template_metadata, TemplateMetadata, SlotMetadata
from services.face_service import face_service
from services.storage_service import storage_service
from services.stats_service import stats_service

router = APIRouter()

# Base paths (relative to project root, not backend folder)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
TEMPLATES_DIR = os.path.join(PROJECT_ROOT, "templates")
OUTPUTS_DIR = os.path.join(PROJECT_ROOT, settings.OUTPUTS_DIR)

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
    processing_mode: str = Form("sticker"),  # "sticker", "frame", "pre_extracted"
    photo_position: Optional[str] = Form(None),  # JSON: {"x", "y", "scale", "editorWidth"}
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
    print(f"\n{'='*50}", flush=True)
    print(f"PERF: Generate request — mode={processing_mode}, template={template_id}", flush=True)
    t_total = time.perf_counter()
    
    try:
        # Validate inputs
        if not photos:
            raise HTTPException(status_code=400, detail="At least one photo is required")
        
        # Validate processing mode
        if processing_mode not in ["sticker", "frame", "pre_extracted"]:
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
                t_step = time.perf_counter()
                sticker_image = await rembg_service.remove_background(photo_bytes)
                print(f"PERF:   rembg:     {time.perf_counter() - t_step:.2f}s", flush=True)
                
                # 2. Crop logic (Robust Tight Crop)
                # We crop strictly to alpha bbox to remove empty space, UNLESS full_frame is requested
                anchor_mode = getattr(template_meta, 'anchor_mode', 'bbox_center')
                sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode=anchor_mode)
                
                # 3. Face Detection
                # Must be run on the cropped sticker to get correct relative coordinates
                t_step = time.perf_counter()
                try:
                    landmarks = face_service.detect_landmarks(sticker_image)
                    if landmarks:
                        print(f"DEBUG: Face detected: {landmarks}", flush=True)
                    else:
                        print("DEBUG: No face detected in sticker", flush=True)
                except Exception as e:
                    print(f"DEBUG: Face detection failed: {e}", flush=True)
                print(f"PERF:   face:      {time.perf_counter() - t_step:.2f}s", flush=True)

            elif processing_mode == "pre_extracted":
                # Image is already a transparent PNG from /api/extract
                sticker_image = Image.open(BytesIO(photo_bytes)).convert("RGBA")
                # We can skip landmarks detection unless strictly needed, 
                # but since we are manually positioning, landmarks aren't needed.
                landmarks = None

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
        t_step = time.perf_counter()
        template_path = os.path.join(TEMPLATES_DIR, template_meta.png_path) if template_meta.png_path else None
        
        if processing_mode == "frame" and template_path and os.path.exists(template_path):
            # === FRAME MODE: Simple compositing ===
            # Photo fills the canvas, frame overlays on top.
            # The frame PNG's own transparency defines the visible window.
            
            # Helper to load template image (moved from compose_service to avoid circular dep)
            def _load_template_image(path):
                try:
                    return Image.open(path).convert("RGBA")
                except FileNotFoundError:
                    raise HTTPException(status_code=404, detail=f"Template image not found at {path}")
            
            template_path = os.path.join(TEMPLATES_DIR, template_meta.png_path)
            frame = _load_template_image(template_path).copy()
            
            # Smart Auto-Upscaling: Target at least 1080p width or height
            res_multiplier = max(1.0, 1080 / min(template_meta.width, template_meta.height))
            
            canvas_w = int(template_meta.width * res_multiplier)
            canvas_h = int(template_meta.height * res_multiplier)
            
            print(f"DEBUG FRAME: Using scaled canvas {canvas_w}x{canvas_h} (multiplier={res_multiplier:.2f})", flush=True)
            
            # 1. Start with background or transparent canvas
            canvas = Image.new("RGBA", (canvas_w, canvas_h), (255, 255, 255, 255))
            
            if processed_stickers:
                photo_img = processed_stickers[0]["image"]
                
                # Scale photo to COVER the entire canvas (no gaps)
                photo_ratio = photo_img.width / photo_img.height
                canvas_ratio = canvas_w / canvas_h
                
                if photo_ratio > canvas_ratio:
                    new_h = canvas_h
                    new_w = int(photo_img.width * (canvas_h / photo_img.height))
                else:
                    new_w = canvas_w
                    new_h = int(photo_img.height * (canvas_w / photo_img.width))
                
                photo_resized = photo_img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                
                # Center crop to canvas
                left = (new_w - canvas_w) // 2
                top = (new_h - canvas_h) // 2
                photo_cropped = photo_resized.crop((left, top, left + canvas_w, top + canvas_h))
                
                canvas.paste(photo_cropped, (0, 0))
                print(f"DEBUG FRAME: Photo placed full-canvas ({canvas_w}x{canvas_h})", flush=True)
            
            # Overlay frame on top — ensure it is resized to match high-res canvas
            if frame.size != (canvas_w, canvas_h):
                frame = frame.resize((canvas_w, canvas_h), Image.Resampling.LANCZOS)
                
            final_image = Image.alpha_composite(canvas, frame)
            print(f"DEBUG FRAME: Frame overlaid. Done!", flush=True)
        else:
            # === STICKER MODE: Use existing compose service ===
            final_image = compose_service.compose_final(
                template_path=template_path,
                stickers=processed_stickers,
                template_meta=template_meta,
                processing_mode=processing_mode,
                user_position=user_position,
            )
        print(f"PERF:   compose:   {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # Save via StorageService — encode immediately, defer S3 upload
        t_step = time.perf_counter()
        import asyncio
        result, upload_fn = await storage_service.save_output_deferred(final_image, template_id=template_id)
        print(f"PERF:   encode:    {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # Fire off S3 upload in background — user doesn't wait for it
        asyncio.create_task(upload_fn())
        
        # Track stats
        stats_service.increment_generation(processing_mode, template_id)

        print(f"PERF:   TOTAL:     {time.perf_counter() - t_total:.2f}s (upload runs in background)", flush=True)
        print(f"{'='*50}\n", flush=True)
        
        return GenerateResponse(
            success=True,
            output_id=result.output_id,
            output_url=result.share_url,
            download_url=result.download_url,
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

@router.post("/extract")
async def extract_sticker(
    photo: UploadFile = File(...),
    anchor_mode: str = Form("bbox_center"),
):
    """
    Extracts the subject from the background and returns the transparent PNG directly.
    Used for frontend interactive sticker positioning.
    """
    try:
        photo_bytes = await photo.read()
        
        # 1. Remove background
        sticker_image = await rembg_service.remove_background(photo_bytes)
        
        # 2. Crop to alpha bbox (if not full_frame)
        sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode=anchor_mode)
        
        # Save to buffer and return
        buf = BytesIO()
        sticker_image.save(buf, format="PNG")
        buf.seek(0)
        
        return Response(content=buf.getvalue(), media_type="image/png")
        
    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/download/{output_id}")
async def download_output(output_id: str):
    """Download a generated output image. Serves from local disk (instant) or S3 fallback."""
    # Local storage first: instant serve via FileResponse
    local_path = storage_service.get_local_path(output_id)
    if local_path:
        ext = os.path.splitext(local_path)[1].lstrip(".")
        media_types = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}
        media_type = media_types.get(ext, "image/jpeg")
        return FileResponse(
            local_path,
            media_type=media_type,
            filename=f"photobooth-{output_id}.{ext}",
            headers={"Cache-Control": "public, max-age=31536000, immutable"},
        )
    
    # Fallback: fetch from S3 (for older images not in local cache)
    image_bytes = await storage_service.get_output(output_id)
    if image_bytes is None:
        raise HTTPException(status_code=404, detail="Output not found")
    
    return Response(
        content=image_bytes,
        media_type="image/jpeg",
        headers={
            "Content-Disposition": f'attachment; filename="photobooth-{output_id}.jpg"',
            "Cache-Control": "public, max-age=31536000, immutable"
        },
    )


@router.get("/share/{output_id}")
async def get_share_info(output_id: str):
    """Get share information for a generated output."""
    # Check existence: local path or cloud lookup
    local_path = storage_service.get_local_path(output_id)
    if not local_path:
        image_bytes = await storage_service.get_output(output_id)
        if image_bytes is None:
            raise HTTPException(status_code=404, detail="Output not found")
    
    base_url = settings.BASE_URL
    return {
        "output_id": output_id,
        "download_url": f"{base_url}/api/download/{output_id}",
        "image_url": f"{base_url}/api/download/{output_id}",
        "share_url": f"{base_url}/api/share/{output_id}",
    }


_templates_list_cache = None
_templates_list_ts = 0
_TEMPLATES_LIST_TTL = 60  # seconds

@router.get("/templates")
async def list_templates():
    """List all available templates with their metadata."""
    global _templates_list_cache, _templates_list_ts
    now = time.time()
    if _templates_list_cache is not None and (now - _templates_list_ts) < _TEMPLATES_LIST_TTL:
        return _templates_list_cache

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
    result = {"templates": templates}
    _templates_list_cache = result
    _templates_list_ts = now
    return result


@router.get("/templates/{template_id}/image")
async def get_template_image(template_id: str):
    """Serve a lightweight JPEG thumbnail for template preview (~30-50KB)."""
    meta = load_template_metadata(template_id, TEMPLATES_DIR)
    
    if not meta:
        raise HTTPException(status_code=404, detail="Template not found")
    
    png_path = os.path.join(TEMPLATES_DIR, meta.png_path)
    if not os.path.exists(png_path):
        raise HTTPException(status_code=404, detail="Template image not found")
    
    # Check for cached thumbnail (stored in outputs dir since templates may be read-only)
    thumb_dir = os.path.join(OUTPUTS_DIR, ".thumbnails")
    os.makedirs(thumb_dir, exist_ok=True)
    thumb_path = os.path.join(thumb_dir, f"{template_id}.jpg")
    
    if not os.path.exists(thumb_path):
        # Generate thumbnail: 400px max dimension, JPEG quality 80
        img = Image.open(png_path)
        img.thumbnail((400, 400), Image.Resampling.BICUBIC)
        # Convert RGBA to RGB for JPEG
        if img.mode == "RGBA":
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            img = bg
        img.save(thumb_path, format="JPEG", quality=80)
        print(f"INFO: Generated thumbnail for {template_id} ({os.path.getsize(thumb_path) / 1024:.0f}KB)", flush=True)
    
    return FileResponse(
        thumb_path,
        media_type="image/jpeg",
        filename=f"{template_id}_thumb.jpg",
        headers={"Cache-Control": "public, max-age=86400"},  # Cache 24h
    )


@router.get("/output/{output_id}")
async def get_output(output_id: str):
    """Retrieve a previously generated output by ID."""
    # Check existence: local path or cloud lookup
    local_path = storage_service.get_local_path(output_id)
    if not local_path:
        image_bytes = await storage_service.get_output(output_id)
        if image_bytes is None:
            raise HTTPException(status_code=404, detail="Output not found")
    
    base_url = settings.BASE_URL
    return {
        "output_id": output_id,
        "download_url": f"{base_url}/api/download/{output_id}",
        "share_url": f"{base_url}/api/share/{output_id}",
        "template_id": output_id.split("-")[0] if "-" in output_id else "unknown",
    }
