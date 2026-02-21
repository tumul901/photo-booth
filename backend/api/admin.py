from fastapi import APIRouter, File, UploadFile, HTTPException, Form
from fastapi.responses import JSONResponse, FileResponse
import shutil
import os
import json
from typing import List, Optional
from services.stats_service import stats_service
from pathlib import Path
from pydantic import BaseModel

router = APIRouter()

# --- Stats Endpoints ---

@router.get("/stats")
async def get_stats():
    """Get current usage statistics."""
    return stats_service.get_stats()

# --- Template Management Endpoints ---

# Base paths (relative to project root)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
TEMPLATES_DIR = os.path.join(PROJECT_ROOT, "templates")

# Ensure templates dir exists
os.makedirs(TEMPLATES_DIR, exist_ok=True)

class TemplateInfo(BaseModel):
    id: str
    name: str
    mode: str  # 'frame' or 'sticker'
    preview_url: str

@router.get("/templates")
async def list_templates():
    """List all available templates with metadata."""
    templates = []
    
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
            
        try:
            with open(os.path.join(TEMPLATES_DIR, filename), 'r') as f:
                meta = json.load(f)
                
            # Normalize legacy fields
            t_id = meta.get("id") or meta.get("templateId")
            if not t_id:
                continue
                
            name = meta.get("name", "Unknown")
            mode = meta.get("mode") or meta.get("templateType", "sticker")
            png_path = meta.get("png_path") or meta.get("pngUrl", "")
            
            # Fix legacy paths
            if png_path.startswith("templates/") or png_path.startswith("templates\\"):
                png_path = os.path.basename(png_path)

            templates.append({
                "id": t_id,
                "name": name,
                "mode": mode,
                "png_path": png_path
            })
        except Exception as e:
            print(f"Error reading template meta {filename}: {e}")
                
    return templates

@router.get("/templates/{template_id}/image")
async def get_template_image(template_id: str):
    """Serve the template image."""
    # Find meta file to get image path
    found_meta = None
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(TEMPLATES_DIR, filename), 'r') as f:
                meta = json.load(f)
                t_id = meta.get("id") or meta.get("templateId")
                if t_id == template_id:
                    found_meta = meta
                    break
        except:
            continue
            
    if not found_meta:
        raise HTTPException(status_code=404, detail="Template not found")
        
    png_path = found_meta.get("png_path") or found_meta.get("pngUrl", "")
    # Fix legacy path
    if png_path.startswith("templates/") or png_path.startswith("templates\\"):
        png_path = os.path.basename(png_path)
        
    image_path = os.path.join(TEMPLATES_DIR, png_path)
    
    if not os.path.exists(image_path):
        raise HTTPException(status_code=404, detail="Image file not found")
        
    return FileResponse(image_path)

@router.post("/templates")
async def upload_template(
    file: UploadFile = File(...),
    mode: str = Form(...),  # 'frame' or 'sticker'
    name: str = Form(...),
):
    """Upload a new template."""
    try:
        # Generate safe filename ID
        safe_name = "".join([c for c in name if c.isalnum() or c in ('-', '_')]).lower()
        if not safe_name:
            safe_name = "template"
        
        # Save image file
        file_ext = os.path.splitext(file.filename)[1]
        image_filename = f"{safe_name}{file_ext}"
        image_path = os.path.join(TEMPLATES_DIR, image_filename)
        
        with open(image_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)
            
        # Create metadata structure
        template_id = safe_name
        meta_filename = f"{template_id}.json"
        meta_path = os.path.join(TEMPLATES_DIR, meta_filename)
        
        # Basic slot configuration (default center slot for frames)
        slots = []
        if mode == 'frame':
            # Default to a decent center slot
            slots.append({
                "id": "slot1",
                "x": 100, "y": 100, 
                "width": 1000, "height": 1000, # Placeholder, user might need to edit JSON 
                "rotation": 0
            })
            
        meta = {
            "id": template_id,
            "name": name,
            "mode": mode,
            "png_path": image_filename,
            "slots": slots
        }
        
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=2)
            
        return {"success": True, "template": meta}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Upload failed: {str(e)}")

@router.delete("/templates/{template_id}")
async def delete_template(template_id: str):
    """Delete a template and its associated files."""
    meta_path = os.path.join(TEMPLATES_DIR, f"{template_id}.json")
    
    if not os.path.exists(meta_path):
        raise HTTPException(status_code=404, detail="Template not found")
        
    try:
        # Read meta to find image path
        with open(meta_path, 'r') as f:
            meta = json.load(f)
            
        image_path = os.path.join(TEMPLATES_DIR, meta.get("png_path", ""))
        
        # Delete meta file
        os.remove(meta_path)
        
        # Delete image file
        if os.path.exists(image_path):
            os.remove(image_path)
            
        return {"success": True}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")


# --- Template Configuration (from Visual Editor) ---

class SlotConfig(BaseModel):
    id: str
    x: int
    y: int
    width: int
    height: int
    anchorX: float  # 0-1 relative position within slot
    anchorY: float

class TemplateConfigUpdate(BaseModel):
    templateId: str
    name: str
    templateType: str  # 'frame' or 'sticker'
    compositeMode: str  # 'background' or 'overlay'
    pngUrl: str
    anchorMode: str  # 'face_center', 'eyes', 'none'
    dimensions: dict  # {width, height}
    slots: List[SlotConfig]
    desiredFaceRatio: float
    minZoom: float
    maxZoom: float


@router.put("/templates/{template_id}/config")
async def update_template_config(template_id: str, config: TemplateConfigUpdate):
    """
    Update template configuration from the visual editor.
    Converts editor format to proper JSON structure for the photo booth.
    """
    # Find existing template JSON
    meta_path = None
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(TEMPLATES_DIR, filename), 'r') as f:
                meta = json.load(f)
                t_id = meta.get("id") or meta.get("templateId")
                if t_id == template_id:
                    meta_path = os.path.join(TEMPLATES_DIR, filename)
                    break
        except:
            continue
    
    if not meta_path:
        raise HTTPException(status_code=404, detail="Template not found")
    
    # Read existing config to preserve pngUrl
    try:
        with open(meta_path, 'r') as f:
            existing_meta = json.load(f)
        original_png_url = existing_meta.get("pngUrl") or existing_meta.get("png_path", "")
    except:
        original_png_url = config.pngUrl  # Fallback to what frontend sent
    
    try:
        # Build the complete JSON config
        template_json = {
            "templateId": template_id,
            "name": config.name,
            "templateType": config.templateType,
            "compositeMode": config.compositeMode,
            "pngUrl": original_png_url,
            "anchorMode": config.anchorMode,
            "dimensions": config.dimensions,
            "slots": [
                {
                    "slotId": slot.id,
                    "x": slot.x,
                    "y": slot.y,
                    "width": slot.width,
                    "height": slot.height,
                    "anchor": {
                        # Convert relative (0-1) to absolute pixels
                        "targetX": int(slot.width * slot.anchorX),
                        "targetY": int(slot.height * slot.anchorY),
                    },
                    "desiredFaceRatio": config.desiredFaceRatio,
                    "minZoom": config.minZoom,
                    "maxZoom": config.maxZoom,
                    "zIndex": i
                }
                for i, slot in enumerate(config.slots)
            ],
            "metadata": {
                "category": "custom",
                "tags": [],
                "author": "Admin"
            }
        }
        
        # Write to file
        with open(meta_path, 'w') as f:
            json.dump(template_json, f, indent=2)
        
        print(f"DEBUG: Saved template config: {template_id}")
        return {"success": True, "config": template_json}
        
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Save failed: {str(e)}")


@router.get("/templates/{template_id}/config")
async def get_template_config(template_id: str):
    """Get full template configuration for the editor."""
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            with open(os.path.join(TEMPLATES_DIR, filename), 'r') as f:
                meta = json.load(f)
                t_id = meta.get("id") or meta.get("templateId")
                if t_id == template_id:
                    return meta
        except:
            continue
    
    raise HTTPException(status_code=404, detail="Template not found")

