from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Query, Body
from fastapi.responses import JSONResponse, FileResponse
import base64
import shutil
import os
import json
import time
from typing import List, Optional
from services.stats_service import stats_service
from services.storage_service import storage_service
from services.archive_service import archive_service
from config import settings
from pathlib import Path
from pydantic import BaseModel
import services.compose as compose_service

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
            t_id = meta.get("templateId") or meta.get("id")
            if not t_id:
                continue
                
            name = meta.get("name", "Unknown")
            mode = meta.get("templateType") or meta.get("mode", "sticker")
            png_path = meta.get("pngUrl") or meta.get("png_path", "")
            
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
            
        if mode == "frame":
            composite_mode = "overlay"
        elif mode == "magazine":
            composite_mode = "magazine"
        else:
            composite_mode = "background"

        meta = {
            "templateId": template_id,
            "name": name,
            "templateType": mode,
            "compositeMode": composite_mode,
            "pngUrl": image_filename,
            "png_path": image_filename,
            "fg_path": "",  # Set later via /fg endpoint
            "anchorMode": "face_center" if mode == "magazine" else "bbox_center",
            "dimensions": {
                "width": 1200,
                "height": 1600
            },
            "slots": slots,
            "metadata": {
                "category": "custom",
                "tags": [],
                "author": "Admin"
            }
        }
        
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=2)
            
        compose_service.clear_template_cache()
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
            
        png_path = meta.get("png_path") or meta.get("pngUrl")
        
        # Delete meta file first so it's gone from the UI immediately
        os.remove(meta_path)
        
        # Then attempt to delete associated image file
        if png_path:
            # Fix legacy paths (strip "templates/" prefix if exists)
            if png_path.startswith("templates/") or png_path.startswith("templates\\"):
                png_path = os.path.basename(png_path)
            
            image_path = os.path.join(TEMPLATES_DIR, png_path)
            if os.path.exists(image_path) and os.path.isfile(image_path):
                os.remove(image_path)
                print(f"DEBUG: Deleted template image: {image_path}")
            
        compose_service.clear_template_cache()
        return {"success": True}
        
    except Exception as e:
        print(f"ERROR deleting template: {e}")
        # Even if we hit an error here, the meta file might already be gone
        return {"success": True, "warning": f"Template metadata deleted, but hit an error: {str(e)}"}


# --- Template Configuration (from Visual Editor) ---

class SlotConfig(BaseModel):
    id: str
    x: int
    y: int
    width: int
    height: int
    anchorX: float  # 0-1 relative position within slot
    anchorY: float

class TextConfig(BaseModel):
    """
    Position and style for a single dynamic text element (name or designation)
    rendered by Pillow at photo generation time.
    All pixel values are in the template's native coordinate space.
    """
    x: int = 0
    y: int = 0
    fontSize: int = 60         # Maps to MagazineTextConfig.font_size
    color: str = "#FFFFFF"
    fontPath: str = ""         # Absolute server path to TTF; empty = system default
    fontName: str = ""         # Font stem (e.g. "Roboto-Bold"); resolved to path at render
    maxWidth: int = 0          # 0 = no limit
    align: str = "left"        # "left" | "center" | "right"
    uppercase: bool = False
    rotation: float = 0.0      # Degrees CCW; (x,y) is the rotation pivot

class TemplateConfigUpdate(BaseModel):
    templateId: str
    name: str
    templateType: str  # 'frame', 'sticker', or 'magazine'
    compositeMode: str  # 'background', 'overlay', or 'magazine'
    pngUrl: str
    fg_path: str = ""  # Magazine foreground overlay filename
    anchorMode: str  # 'face_center', 'eyes', 'none'
    dimensions: dict  # {width, height}
    slots: List[SlotConfig]
    desiredFaceRatio: float
    minZoom: float
    maxZoom: float
    stickerFilter: str = "none"
    showVisualGuide: bool = False
    allowManualPositioning: bool = False
    name_text: Optional[TextConfig] = None
    designation_text: Optional[TextConfig] = None
    fg_offset: Optional[dict] = None
    # Luggage card printing mode
    luggage_card_mode: bool = False
    print_dpi: int = 300
    print_width_mm: float = 86.0
    print_height_mm: float = 54.0
    output_format: str = "png"  # "png" | "jpeg_print"


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
        # Preserve existing fg_path if frontend didn't send one
        existing_fg_path = existing_meta.get("fg_path", "")
        fg_path_to_save = config.fg_path if config.fg_path else existing_fg_path

        # Build the complete JSON config
        template_json = {
            "templateId": template_id,
            "name": config.name,
            "templateType": config.templateType,
            "compositeMode": config.compositeMode,
            "pngUrl": original_png_url,
            "png_path": original_png_url,
            "fg_path": fg_path_to_save,
            "anchorMode": config.anchorMode,
            "stickerFilter": config.stickerFilter,
            "showVisualGuide": config.showVisualGuide,
            "allowManualPositioning": config.allowManualPositioning,
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
            },
            # Text overlay config (magazine + sticker/luggage card)
            # When the user unchecks a field, frontend sends None — we save {} to clear it.
            # Do NOT fall back to existing_meta here, or unchecking would never persist.
            "name_text": config.name_text.model_dump() if config.name_text else {},
            "designation_text": config.designation_text.model_dump() if config.designation_text else {},
            "fg_offset": config.fg_offset if config.fg_offset is not None else existing_meta.get("fg_offset", {"x": 0, "y": 0}),
            # Luggage card printing mode
            "luggage_card_mode": config.luggage_card_mode,
            "print_dpi": config.print_dpi,
            "print_width_mm": config.print_width_mm,
            "print_height_mm": config.print_height_mm,
            "output_format": config.output_format,
        }
        
        # Write to file
        with open(meta_path, 'w') as f:
            json.dump(template_json, f, indent=2)
        
        # Unique signature to verify this code version on VPS
        print(f"DEBUG_V2: Saving config for {template_id}")
        compose_service.clear_template_cache()
        return {"success": True, "message": "Template saved successfully (v2)"}
        
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


# --- Gallery ---

# In-memory sort cache: holds all items sorted by last_modified desc.
# Rebuilt on first request and on explicit invalidation; expires after TTL.
_gallery_cache: list | None = None
_gallery_cache_time: float = 0.0
_GALLERY_CACHE_TTL = 30.0  # seconds


def _invalidate_gallery_cache() -> None:
    global _gallery_cache, _gallery_cache_time
    _gallery_cache = None
    _gallery_cache_time = 0.0


def _fetch_all_items() -> list:
    """Fetch every item from S3 (or local), sort by last_modified desc, cache."""
    global _gallery_cache, _gallery_cache_time
    now = time.time()
    if _gallery_cache is not None and (now - _gallery_cache_time) < _GALLERY_CACHE_TTL:
        return _gallery_cache

    provider = storage_service.provider
    items = []

    if not hasattr(provider, 's3'):
        # Local storage fallback
        outputs_dir = getattr(provider, 'output_dir', 'outputs')
        if os.path.isdir(outputs_dir):
            for fname in os.listdir(outputs_dir):
                fpath = os.path.join(outputs_dir, fname)
                if not os.path.isfile(fpath):
                    continue
                output_id = os.path.splitext(fname)[0]
                stat = os.stat(fpath)
                items.append({
                    "output_id": output_id,
                    "filename": fname,
                    "url": f"{provider.base_url}/api/download/{output_id}",
                    "size": stat.st_size,
                    "last_modified": stat.st_mtime,
                    "last_modified_iso": None,
                    "template_prefix": output_id.rsplit('-', 1)[0] if '-' in output_id else output_id,
                })
    else:
        try:
            paginator = provider.s3.get_paginator('list_objects_v2')
            for page in paginator.paginate(Bucket=provider.bucket, Prefix=provider.prefix):
                for obj in page.get('Contents', []):
                    key = obj['Key']
                    filename = key.replace(provider.prefix, '', 1)
                    output_id = os.path.splitext(filename)[0]
                    lm = obj['LastModified']
                    url = (
                        f"{provider.cdn_url}/{key}"
                        if getattr(provider, 'cdn_url', None)
                        else f"{provider.base_url}/api/download/{output_id}"
                    )
                    items.append({
                        "output_id": output_id,
                        "filename": filename,
                        "url": url,
                        "size": obj['Size'],
                        "last_modified": lm.timestamp(),
                        "last_modified_iso": lm.isoformat(),
                        "template_prefix": output_id.rsplit('-', 1)[0] if '-' in output_id else output_id,
                    })
        except Exception as e:
            raise HTTPException(status_code=500, detail=f"Failed to list gallery: {str(e)}")

    items.sort(key=lambda x: x["last_modified"], reverse=True)
    _gallery_cache = items
    _gallery_cache_time = now
    return items


def _make_cursor(offset: int) -> str:
    return base64.urlsafe_b64encode(json.dumps({"offset": offset}).encode()).decode()


def _parse_cursor(cursor: str) -> int:
    try:
        return json.loads(base64.urlsafe_b64decode(cursor))["offset"]
    except Exception:
        return 0


@router.get("/gallery/templates")
async def list_gallery_templates():
    """Return distinct template prefixes from the current cached listing."""
    all_items = _fetch_all_items()
    prefixes = sorted({item["template_prefix"] for item in all_items})
    return {"templates": prefixes}


@router.get("/gallery")
async def list_gallery(
    limit: int = Query(50, ge=1, le=200),
    cursor: Optional[str] = Query(None),
    view: str = Query("active", pattern="^(active|archived|all)$"),
    template: Optional[str] = Query(None),
):
    """
    List gallery items — sorted by date desc, paginated, filterable.
    view: active (default) | archived | all
    template: filter by template_prefix
    cursor: opaque pagination token from previous response
    """
    all_items = _fetch_all_items()
    archived_ids = set(archive_service.list_archived())

    # Apply view filter
    if view == "active":
        filtered = [i for i in all_items if i["output_id"] not in archived_ids]
    elif view == "archived":
        filtered = [i for i in all_items if i["output_id"] in archived_ids]
    else:
        filtered = all_items

    # Apply template filter
    if template:
        filtered = [i for i in filtered if i["template_prefix"] == template]

    total_active = sum(1 for i in all_items if i["output_id"] not in archived_ids)
    total_archived = len(archived_ids)

    offset = _parse_cursor(cursor) if cursor else 0
    page = filtered[offset: offset + limit]
    next_offset = offset + limit
    has_more = next_offset < len(filtered)

    items_out = []
    for item in page:
        items_out.append({
            "output_id": item["output_id"],
            "filename": item["filename"],
            "url": item["url"],
            "size": item["size"],
            "last_modified": item["last_modified_iso"] or item["last_modified"],
            "template_prefix": item["template_prefix"],
            "archived": item["output_id"] in archived_ids,
        })

    return {
        "items": items_out,
        "next_cursor": _make_cursor(next_offset) if has_more else None,
        "has_more": has_more,
        "total_active": total_active,
        "total_archived": total_archived,
    }


class BulkIdsBody(BaseModel):
    ids: List[str]


class ConfirmBody(BaseModel):
    confirm: str


@router.post("/gallery/archive")
async def archive_images(body: BulkIdsBody):
    """Soft-hide a list of output_ids from the active gallery view."""
    added = archive_service.add_many(body.ids)
    _invalidate_gallery_cache()
    return {"success": True, "archived": added}


@router.post("/gallery/unarchive")
async def unarchive_images(body: BulkIdsBody):
    """Restore a list of output_ids to the active gallery view."""
    removed = archive_service.remove_many(body.ids)
    _invalidate_gallery_cache()
    return {"success": True, "unarchived": removed}


@router.delete("/gallery/bulk")
async def bulk_delete_images(body: BulkIdsBody):
    """Delete a list of output_ids from storage (S3 + local) and archived list."""
    results = {"deleted": [], "not_found": [], "errors": []}
    for output_id in body.ids:
        try:
            deleted = await storage_service.delete_output(output_id)
            if deleted:
                results["deleted"].append(output_id)
            else:
                results["not_found"].append(output_id)
        except Exception as e:
            results["errors"].append({"id": output_id, "error": str(e)})
    # Remove deleted ids from archive list too
    all_removed = results["deleted"] + results["not_found"]
    if all_removed:
        archive_service.remove_many(all_removed)
    _invalidate_gallery_cache()
    return {"success": True, **results}


@router.delete("/gallery/all")
async def delete_all_images(body: ConfirmBody):
    """
    Delete every output image from storage.
    Requires body: {"confirm": "delete"} as a safety guard.
    """
    if body.confirm != "delete":
        raise HTTPException(status_code=400, detail='Body must contain {"confirm": "delete"}')

    all_items = _fetch_all_items()
    results = {"deleted": 0, "errors": []}
    for item in all_items:
        try:
            await storage_service.delete_output(item["output_id"])
            results["deleted"] += 1
        except Exception as e:
            results["errors"].append({"id": item["output_id"], "error": str(e)})

    # Clear the entire archive list as well
    archive_service.remove_many([i["output_id"] for i in all_items])
    _invalidate_gallery_cache()
    return {"success": True, **results}


# --- Magazine: Foreground Image Upload & Serve ---

def _find_template_meta_path(template_id: str):
    """Return (meta_dict, meta_path) for a template, or (None, None)."""
    for filename in os.listdir(TEMPLATES_DIR):
        if not filename.endswith(".json"):
            continue
        try:
            path = os.path.join(TEMPLATES_DIR, filename)
            with open(path, "r") as f:
                meta = json.load(f)
            if meta.get("templateId") == template_id or meta.get("id") == template_id:
                return meta, path
        except Exception:
            continue
    return None, None


@router.post("/templates/{template_id}/fg")
async def upload_fg_image(template_id: str, file: UploadFile = File(...)):
    """Upload the foreground overlay image for a magazine template."""
    meta, meta_path = _find_template_meta_path(template_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Template not found")

    file_ext = os.path.splitext(file.filename or "fg.png")[1] or ".png"
    fg_filename = f"{template_id}_fg{file_ext}"
    fg_path = os.path.join(TEMPLATES_DIR, fg_filename)

    with open(fg_path, "wb") as buf:
        shutil.copyfileobj(file.file, buf)

    meta["fg_path"] = fg_filename
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2)

    compose_service.clear_template_cache()
    return {"success": True, "fg_path": fg_filename}


@router.get("/templates/{template_id}/fg-image")
async def get_fg_image(template_id: str):
    """Serve the foreground overlay image for a magazine template."""
    meta, _ = _find_template_meta_path(template_id)
    if not meta:
        raise HTTPException(status_code=404, detail="Template not found")

    fg_filename = meta.get("fg_path", "")
    if not fg_filename:
        raise HTTPException(status_code=404, detail="No foreground image set for this template")

    fg_path = os.path.join(TEMPLATES_DIR, fg_filename)
    if not os.path.exists(fg_path):
        raise HTTPException(status_code=404, detail="Foreground image file not found")

    return FileResponse(fg_path)


@router.get("/fonts")
async def list_fonts():
    """List available custom fonts from backend/fonts/ directory."""
    fonts_dir = os.path.join(PROJECT_ROOT, "backend", "fonts")
    fonts = []
    if os.path.isdir(fonts_dir):
        for fname in sorted(os.listdir(fonts_dir)):
            if fname.lower().endswith((".ttf", ".otf")):
                stem = os.path.splitext(fname)[0]
                fonts.append({"name": stem, "path": os.path.join(fonts_dir, fname)})
    return {"fonts": fonts}


@router.delete("/gallery/{output_id}")
async def delete_gallery_image(output_id: str):
    """Delete a single output image from storage (S3 or local)."""
    try:
        deleted = await storage_service.delete_output(output_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Image not found")
        archive_service.remove(output_id)
        _invalidate_gallery_cache()
        return {"success": True, "deleted": output_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")
