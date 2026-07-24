from fastapi import APIRouter, File, UploadFile, HTTPException, Form, Query
from fastapi.responses import FileResponse, StreamingResponse
import shutil
import os
import json
import io
import zipfile
from datetime import datetime, timezone
from typing import List, Optional
from services.stats_service import stats_service
from services.storage_service import storage_service
from services.archive_service import archive_service
from services.jobs_service import jobs_service
from config import settings
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
    # --- Extended styling ---
    letterSpacing: float = 0.0   # Inter-character spacing, native px (can be negative)
    strokeWidth: int = 0         # Text outline width, native px (0 = no outline)
    strokeColor: str = "#000000" # Outline colour
    shadowBlur: int = 0          # Drop-shadow blur radius, native px (0 = no shadow)
    shadowColor: str = "#000000" # Drop-shadow colour
    shadowOffsetX: int = 0       # Drop-shadow horizontal offset, native px
    shadowOffsetY: int = 0       # Drop-shadow vertical offset, native px
    opacity: int = 100           # 0-100 text opacity

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
    # Baseline placement: {"x1", "x2", "y"} in template-native pixels. The segment
    # encodes subject bottom (y), horizontal center (midpoint), and target width.
    baseline: Optional[dict] = None
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
            # Baseline placement segment (preserve existing if frontend omitted it)
            "baseline": config.baseline if config.baseline is not None else existing_meta.get("baseline"),
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


from functools import lru_cache as _lru_cache


@_lru_cache(maxsize=64)
def _png_transparent_pct(path: str, mtime: float) -> float:
    """
    Fraction (0-100) of a template PNG that is fully transparent — i.e. how big a
    'photo window' it has. Cached by (path, mtime). ~0 means a solid card with no
    window, which only works as a BACKGROUND, never as an OVERLAY.
    """
    try:
        from PIL import Image as _Img
        _Img.MAX_IMAGE_PIXELS = None
        im = _Img.open(path)
        if im.mode != "RGBA":
            return 0.0
        # Downsample for speed — the transparent fraction is stable under scaling.
        im.thumbnail((256, 256))
        alpha = im.getchannel("A")
        hist = alpha.histogram()
        total = sum(hist) or 1
        return 100.0 * hist[0] / total
    except Exception:
        return -1.0  # unknown


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
                    # Annotate how much transparent 'photo window' the PNG has, so the
                    # editor can warn when an opaque template is set to overlay mode.
                    png_file = meta.get("png_path") or meta.get("pngUrl", "")
                    if png_file.startswith("templates/") or png_file.startswith("templates\\"):
                        png_file = os.path.basename(png_file)
                    img_path = os.path.join(TEMPLATES_DIR, png_file)
                    if os.path.exists(img_path):
                        meta["_pngTransparentPct"] = _png_transparent_pct(img_path, os.path.getmtime(img_path))
                    return meta
        except:
            continue

    raise HTTPException(status_code=404, detail="Template not found")


# --- Gallery ---

def _job_to_card(job: dict, base_url: str) -> dict:
    """Convert a jobs DB row to the card shape the frontend expects."""
    output_id = job["output_id"]
    created_ts = job["created_at"]
    created_iso = datetime.fromtimestamp(created_ts, tz=timezone.utc).isoformat()
    downloaded_ts = job.get("downloaded_at")
    downloaded_iso = (
        datetime.fromtimestamp(downloaded_ts, tz=timezone.utc).isoformat()
        if downloaded_ts else None
    )
    return {
        "output_id": output_id,
        "filename": f"{output_id}.jpg",
        "url": f"{base_url}/api/download/{output_id}",
        # Operator downloads include ?source=app so downloaded_at is set
        "download_url": f"{base_url}/api/download/{output_id}?source=app",
        "size": job.get("file_size", 0),
        "created_at": created_iso,
        "last_modified": created_iso,  # kept for backwards-compat with old frontend field
        "template_prefix": job.get("template_prefix", ""),
        "mode": job.get("mode", ""),
        "guest_name": job.get("guest_name", ""),
        "guest_phone": job.get("guest_phone", ""),
        "archived": bool(job.get("archived", 0)),
        "downloaded_at": downloaded_iso,
    }


# ── Section list ──────────────────────────────────────────────────────────────

@router.get("/gallery/sections")
async def gallery_sections(
    status: str = Query("active", pattern="^(active|downloaded|archived)$"),
):
    """
    Cheap GROUP-BY call: returns tab counts + ordered date sections.
    The frontend uses this to build the collapsible section headers
    without loading any photo data yet.
    """
    data = jobs_service.get_sections(status)
    return data


# ── Per-section paginated photo list ─────────────────────────────────────────

@router.get("/gallery")
async def list_gallery(
    status: str = Query("active", pattern="^(active|downloaded|archived)$"),
    date: str = Query(...),           # 'today' | 'yesterday' | 'DD/MM/YYYY'
    limit: int = Query(75, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    """
    Paginated photo list for one date section.
    Called lazily when the operator expands a section.
    """
    base_url = settings.BASE_URL
    rows = jobs_service.get_jobs_for_section(date, status=status, limit=limit, offset=offset)
    items = [_job_to_card(r, base_url) for r in rows]
    return {"items": items, "offset": offset, "limit": limit, "count": len(items)}


# ── Search ────────────────────────────────────────────────────────────────────

@router.get("/gallery/search")
async def search_gallery(
    q: str = Query(..., min_length=1),
    status: str = Query("active", pattern="^(active|downloaded|archived)$"),
    limit: int = Query(50, ge=1, le=200),
):
    """Cross-section name / output_id search. Returns flat results with section annotation."""
    base_url = settings.BASE_URL
    rows = jobs_service.search(q, status=status, limit=limit)
    items = [_job_to_card(r, base_url) for r in rows]
    return {"items": items, "query": q}


# ── Template prefix list ──────────────────────────────────────────────────────

@router.get("/gallery/templates")
async def list_gallery_templates(
    status: str = Query("active", pattern="^(active|downloaded|archived)$"),
):
    """Return distinct template prefixes for the filter dropdown."""
    prefixes = jobs_service.get_template_prefixes(status)
    return {"templates": prefixes}


# ── Mark / unmark downloaded ──────────────────────────────────────────────────

class BulkIdsBody(BaseModel):
    ids: List[str]


class ZipBody(BaseModel):
    # Either pass explicit ids OR (date + status) to let the server resolve all IDs
    ids: Optional[List[str]] = None
    date: Optional[str] = None   # 'today' | 'yesterday' | 'DD/MM/YYYY'
    status: str = "active"       # 'active' | 'downloaded' | 'archived' | 'all'


class ConfirmBody(BaseModel):
    confirm: str


@router.patch("/gallery/{output_id}/mark-downloaded")
async def mark_downloaded(output_id: str):
    jobs_service.mark_downloaded(output_id)
    return {"success": True}


@router.patch("/gallery/{output_id}/unmark-downloaded")
async def unmark_downloaded(output_id: str):
    jobs_service.unmark_downloaded(output_id)
    return {"success": True}


@router.patch("/gallery/bulk/mark-downloaded")
async def bulk_mark_downloaded(body: BulkIdsBody):
    count = jobs_service.bulk_mark_downloaded(body.ids)
    return {"success": True, "updated": count}


@router.patch("/gallery/bulk/unmark-downloaded")
async def bulk_unmark_downloaded(body: BulkIdsBody):
    count = jobs_service.bulk_unmark_downloaded(body.ids)
    return {"success": True, "updated": count}


# ── Archive / unarchive ───────────────────────────────────────────────────────

@router.post("/gallery/archive")
async def archive_images(body: BulkIdsBody):
    """Soft-hide photos from the active/downloaded views."""
    count = jobs_service.bulk_set_archived(body.ids, True)
    # Keep archive_service in sync for any legacy callers
    archive_service.add_many(body.ids)
    return {"success": True, "archived": count}


@router.post("/gallery/unarchive")
async def unarchive_images(body: BulkIdsBody):
    count = jobs_service.bulk_set_archived(body.ids, False)
    archive_service.remove_many(body.ids)
    return {"success": True, "unarchived": count}


# ── ZIP download ──────────────────────────────────────────────────────────────

@router.post("/gallery/zip")
async def download_zip(body: ZipBody):
    """
    Stream a ZIP of output images.
    Pass explicit `ids` list OR `date + status` to zip an entire date section
    (the server resolves all output_ids from the DB so pagination is not a problem).
    The download also marks all included photos as downloaded.
    """
    if body.date:
        # Server resolves every output_id for this date section — no page cap
        rows = jobs_service.get_jobs_for_section(body.date, status=body.status, limit=10_000, offset=0)
        ids = [r["output_id"] for r in rows]
        filename = f"photobooth-{body.date}.zip"
    elif body.ids:
        ids = body.ids
        filename = "photobooth-photos.zip"
    else:
        raise HTTPException(status_code=400, detail="Provide either `ids` or `date`")

    if not ids:
        raise HTTPException(status_code=404, detail="No photos found for this request")

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
        for output_id in ids:
            local_path = storage_service.get_local_path(output_id)
            if local_path and os.path.exists(local_path):
                ext = os.path.splitext(local_path)[1]
                with open(local_path, "rb") as f:
                    zf.writestr(f"photobooth-{output_id}{ext}", f.read())
            else:
                image_bytes = await storage_service.get_output(output_id)
                if image_bytes:
                    zf.writestr(f"photobooth-{output_id}.jpg", image_bytes)

    jobs_service.bulk_mark_downloaded(ids)

    buf.seek(0)
    return StreamingResponse(
        buf,
        media_type="application/zip",
        headers={"Content-Disposition": f"attachment; filename={filename}"},
    )


# ── Bulk delete ───────────────────────────────────────────────────────────────

@router.delete("/gallery/bulk")
async def bulk_delete_images(body: BulkIdsBody):
    """Delete a list of output_ids from storage (S3 + local) and the jobs DB."""
    results: dict = {"deleted": [], "not_found": [], "errors": []}
    for output_id in body.ids:
        try:
            deleted = await storage_service.delete_output(output_id)
            if deleted:
                results["deleted"].append(output_id)
            else:
                results["not_found"].append(output_id)
        except Exception as e:
            results["errors"].append({"id": output_id, "error": str(e)})
    all_removed = results["deleted"] + results["not_found"]
    if all_removed:
        jobs_service.bulk_delete(all_removed)
        archive_service.remove_many(all_removed)
    return {"success": True, **results}


@router.delete("/gallery/all")
async def delete_all_images(body: ConfirmBody):
    """Delete every output image. Requires body: {"confirm": "delete"}."""
    if body.confirm != "delete":
        raise HTTPException(status_code=400, detail='Body must contain {"confirm": "delete"}')

    all_ids = list(jobs_service.get_all_ids())

    results: dict = {"deleted": 0, "errors": []}
    for output_id in all_ids:
        try:
            await storage_service.delete_output(output_id)
            results["deleted"] += 1
        except Exception as e:
            results["errors"].append({"id": output_id, "error": str(e)})

    jobs_service.bulk_delete(all_ids)
    archive_service.remove_many(all_ids)
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


@router.post("/fonts")
async def upload_font(file: UploadFile = File(...)):
    """
    Upload a custom .ttf or .otf font. Stored in backend/fonts/ and immediately
    available to the template editor (preview) and the compositor (final render).
    Returns the font stem name to select in the UI.
    """
    fonts_dir = os.path.join(PROJECT_ROOT, "backend", "fonts")
    os.makedirs(fonts_dir, exist_ok=True)

    orig = os.path.basename(file.filename or "")
    ext = os.path.splitext(orig)[1].lower()
    if ext not in (".ttf", ".otf"):
        raise HTTPException(status_code=400, detail="Only .ttf or .otf font files are allowed")

    # Sanitise the filename to a safe stem (keep alnum, dot, dash, underscore)
    stem = os.path.splitext(orig)[0]
    safe_stem = "".join(c if (c.isalnum() or c in "._-") else "_" for c in stem).strip("._") or "font"
    safe_name = f"{safe_stem}{ext}"
    dest = os.path.join(fonts_dir, safe_name)

    data = await file.read()
    if not data:
        raise HTTPException(status_code=400, detail="Empty file")

    # Validate it's a real, loadable font before saving (rejects corrupt/misnamed files)
    try:
        from PIL import ImageFont
        from io import BytesIO
        ImageFont.truetype(BytesIO(data), 24)
    except Exception:
        raise HTTPException(status_code=400, detail="File is not a valid TrueType/OpenType font")

    with open(dest, "wb") as f:
        f.write(data)

    print(f"INFO: uploaded font '{safe_name}' ({len(data) / 1024:.0f}KB)", flush=True)
    return {"success": True, "name": safe_stem, "filename": safe_name}


@router.get("/fonts/{font_name}/file")
async def get_font_file(font_name: str):
    """
    Serve a font's raw bytes so the template editor can render text previews in
    the exact typeface the backend composites with (true WYSIWYG placement).
    Matched case-insensitively on the font stem (e.g. "Roboto-Bold").
    """
    fonts_dir = os.path.join(PROJECT_ROOT, "backend", "fonts")
    if os.path.isdir(fonts_dir):
        target = font_name.lower()
        for fname in os.listdir(fonts_dir):
            if not fname.lower().endswith((".ttf", ".otf")):
                continue
            if os.path.splitext(fname)[0].lower() == target:
                path = os.path.join(fonts_dir, fname)
                media = "font/otf" if fname.lower().endswith(".otf") else "font/ttf"
                return FileResponse(
                    path,
                    media_type=media,
                    headers={"Cache-Control": "public, max-age=86400"},
                )
    raise HTTPException(status_code=404, detail="Font not found")


@router.delete("/gallery/{output_id}")
async def delete_gallery_image(output_id: str):
    """Delete a single output image from storage (S3 or local)."""
    try:
        deleted = await storage_service.delete_output(output_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="Image not found")
        jobs_service.delete(output_id)
        archive_service.remove(output_id)
        return {"success": True, "deleted": output_id}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Delete failed: {str(e)}")
