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
from collections import OrderedDict
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
from services.jobs_service import jobs_service
from services.cartoon_service import (
    duotone_preset, get_theme, PRESETS as CARTOON_PRESETS, THEMES as CARTOON_THEMES,
    DEFAULT_PRESET, DEFAULT_THEME, RENDER_HEIGHT,
)
from services.geometric_overlays import compose_duotone_artwork
from services.watercolor_service import (
    watercolor_preset as render_watercolor, PRESETS as WC_PRESETS,
    DEFAULT_PRESET as DEFAULT_WC_PRESET, RENDER_HEIGHT as WC_RENDER_HEIGHT,
)
from services.plexus_background import generate_plexus

router = APIRouter()

# Base paths (relative to project root, not backend folder)
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(__file__)))
TEMPLATES_DIR = os.path.join(PROJECT_ROOT, "templates")
OUTPUTS_DIR = os.path.join(PROJECT_ROOT, settings.OUTPUTS_DIR)

# Ensure outputs directory exists
os.makedirs(OUTPUTS_DIR, exist_ok=True)


# ── Cutout cache ──────────────────────────────────────────────────────────────
# In-memory cache of extracted subject cutouts (post-rembg, post-crop) keyed by
# the generation's output_id. Lets the post-result "Adjust Sticker Placement"
# flow reuse the exact cutout the user already saw instead of re-running
# background removal. Single-worker uvicorn (see Dockerfile) → one process, one
# event loop → no locking needed, same assumption as jobs/archive services.
# Bounded + LRU-evicted; purely ephemeral — on a cache miss (restart, eviction,
# or a mode that never populated it) the adjust flow falls back to /api/extract.
_CUTOUT_CACHE_MAX = 12
_cutout_cache: "OrderedDict[str, Image.Image]" = OrderedDict()


def _cache_cutout(output_id: str, cutout: Image.Image) -> None:
    """Store a cutout under output_id, evicting the oldest beyond the cap."""
    _cutout_cache[output_id] = cutout
    _cutout_cache.move_to_end(output_id)
    while len(_cutout_cache) > _CUTOUT_CACHE_MAX:
        _cutout_cache.popitem(last=False)


def _load_raw_template_config(template_id: str) -> dict:
    """
    Read a template's JSON verbatim, for keys TemplateMetadata doesn't model
    (currently the cartoon triangle geometry). The booth's capture guide reads the
    same file through /api/admin/templates/{id}/config, so the triangle drawn on
    the live camera and the one drawn on the artwork stay in lockstep from a
    single source of truth. Returns {} on any failure — callers use defaults.
    """
    try:
        from services.compose import _resolve_template_json
        path = _resolve_template_json(template_id, TEMPLATES_DIR)
        if path and os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                return json.load(f)
    except Exception as e:
        print(f"WARNING: raw config read failed for {template_id}: {e}", flush=True)
    return {}


def _hex_to_rgb(value: str, fallback: tuple[int, int, int]) -> tuple[int, int, int]:
    """Parse '#RRGGBB' into an RGB tuple, falling back on anything malformed."""
    try:
        h = value.lstrip("#")
        if len(h) == 6:
            return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16))
    except Exception:
        pass
    return fallback


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
    # Actual encoding of the saved file. The booth previously hard-coded a .png
    # filename on every download regardless of what was really saved, so guests
    # received JPEGs named .png. The UI also needs to know when an output carries
    # real transparency, since that is the whole point of the artwork modes.
    output_format: Optional[str] = None
    transparent: Optional[bool] = None


@router.post("/generate", response_model=GenerateResponse)
async def generate_composite(
    template_id: str = Form(...),
    photos: List[UploadFile] = File(...),
    slot_assignments: Optional[str] = Form(None),
    processing_mode: str = Form("sticker"),  # "sticker", "frame", "pre_extracted", "cartoon"
    photo_position: Optional[str] = Form(None),  # JSON: {"x", "y", "scale", "editorWidth"}
    magazine_name: str = Form(""),           # Magazine mode: person's name
    magazine_designation: str = Form(""),    # Magazine mode: person's designation
    overlay_name: str = Form(""),            # Sticker/luggage card: person's name
    overlay_designation: str = Form(""),     # Sticker/luggage card: person's designation
    guest_name: str = Form(""),              # Capture form: guest's name (optional)
    guest_phone: str = Form(""),             # Capture form: guest's phone (optional)
    cartoon_preset: str = Form(DEFAULT_PRESET),  # Cartoon mode: tonal preset name
    cartoon_theme: str = Form(""),               # Colour theme, shared by cartoon + watercolor ("" = template default)
    watercolor_preset: str = Form(DEFAULT_WC_PRESET),  # Watercolor mode: shading preset name
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
        if processing_mode not in ["sticker", "frame", "pre_extracted", "cartoon", "watercolor"]:
            processing_mode = "sticker"

        # Validate presets — an unknown name falls back rather than 500s
        if cartoon_preset not in CARTOON_PRESETS:
            cartoon_preset = DEFAULT_PRESET
        if watercolor_preset not in WC_PRESETS:
            watercolor_preset = DEFAULT_WC_PRESET
        
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
        
        # Cartoon mode reads extra geometry straight from the template JSON.
        # `guest_framed` is true when the booth showed a live triangle guide and the
        # template asks for full_frame: the guest already composed the shot against
        # that guide, so we must preserve their framing rather than re-cropping.
        ART_MODES = ("cartoon", "watercolor")
        raw_template_cfg = _load_raw_template_config(template_id) if processing_mode in ART_MODES else {}
        guest_framed = bool(
            raw_template_cfg.get("showVisualGuide")
            and getattr(template_meta, "anchor_mode", "") == "full_frame"
        )

        # Colour theme: explicit request wins, else the template's own, else the
        # service default. Unknown names fall back rather than 500.
        cartoon_theme = cartoon_theme or raw_template_cfg.get("theme", DEFAULT_THEME)
        if cartoon_theme not in CARTOON_THEMES:
            cartoon_theme = DEFAULT_THEME

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
                        print(f"DEBUG: Face detected: {landmarks} in {time.perf_counter() - t_step:.2f}s", flush=True)
                    else:
                        print(f"DEBUG: No face detected in sticker ({time.perf_counter() - t_step:.2f}s)", flush=True)
                except Exception as e:
                    print(f"DEBUG: Face detection failed: {e}", flush=True)
                print(f"PERF:   face total: {time.perf_counter() - t_step:.2f}s", flush=True)

            elif processing_mode == "cartoon":
                # 1. Remove background
                t_step = time.perf_counter()
                sticker_image = await rembg_service.remove_background(photo_bytes)
                print(f"PERF:   rembg:     {time.perf_counter() - t_step:.2f}s", flush=True)

                # 2. Crop to alpha bbox
                anchor_mode = getattr(template_meta, 'anchor_mode', 'bbox_center')
                sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode=anchor_mode)

                # 3. Face detection — only needed to re-frame. When the guest lined
                #    themselves up against the live triangle guide their framing is
                #    already correct, so we skip detection entirely and save the time.
                if not guest_framed:
                    t_step = time.perf_counter()
                    try:
                        landmarks = face_service.detect_landmarks(sticker_image)
                    except Exception as e:
                        print(f"DEBUG: Face detection failed: {e}", flush=True)
                        landmarks = None
                    print(f"PERF:   face:      {time.perf_counter() - t_step:.2f}s "
                          f"({'found' if landmarks else 'none — using fallback framing'})", flush=True)

                # 4. Duotone map — the portrait keeps its tones but is recoloured
                #    onto the theme's ramp. Rendered at canvas height (never
                #    upscaled) so it stays sharp when mapped 1:1 onto the output.
                t_step = time.perf_counter()
                sticker_image = duotone_preset(
                    sticker_image,
                    preset=cartoon_preset,
                    theme=cartoon_theme,
                    landmarks=landmarks,
                    auto_crop=not guest_framed,
                    render_height=(template_meta.height or RENDER_HEIGHT),
                )
                print(f"PERF:   duotone:   {time.perf_counter() - t_step:.2f}s "
                      f"(preset={cartoon_preset}, theme={cartoon_theme})", flush=True)

            elif processing_mode == "watercolor":
                # 1. Remove background
                t_step = time.perf_counter()
                sticker_image = await rembg_service.remove_background(photo_bytes)
                print(f"PERF:   rembg:     {time.perf_counter() - t_step:.2f}s", flush=True)

                # 2. Trim to the subject
                anchor_mode = getattr(template_meta, 'anchor_mode', 'bbox_center')
                sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode=anchor_mode)

                # 3. Face detection only when we need to re-frame — the guest who
                #    lined up against the live triangle guide already framed it.
                if not guest_framed:
                    t_step = time.perf_counter()
                    try:
                        landmarks = face_service.detect_landmarks(sticker_image)
                    except Exception as e:
                        print(f"DEBUG: Face detection failed: {e}", flush=True)
                    print(f"PERF:   face:      {time.perf_counter() - t_step:.2f}s", flush=True)

                # 4. Illustrated render. The semantic parse happens inside, on the
                #    cutout, so background people the guest happened to stand in
                #    front of are already gone and cannot be parsed as the subject.
                t_step = time.perf_counter()
                sticker_image = render_watercolor(
                    sticker_image,
                    preset=watercolor_preset,
                    theme=cartoon_theme,
                    landmarks=landmarks,
                    auto_crop=not guest_framed,
                    render_height=(template_meta.height or WC_RENDER_HEIGHT),
                )
                print(f"PERF:   watercolor:{time.perf_counter() - t_step:.2f}s "
                      f"(preset={watercolor_preset}, theme={cartoon_theme})", flush=True)

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

        # Preserve the extracted cutout so the post-result "Adjust Placement" flow
        # can reuse it without re-running rembg. Copy now (before compose) so any
        # downstream scaling/mutation in compose_final can't alter what we cache.
        # Cached under the output_id once we have it (after save, below).
        cutout_to_cache = None
        if processing_mode in ("sticker", "pre_extracted") and len(processed_stickers) == 1:
            cutout_to_cache = processed_stickers[0]["image"].copy()

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
        fg_template_path = os.path.join(TEMPLATES_DIR, template_meta.fg_path) if template_meta.fg_path else None

        if processing_mode in ART_MODES:
            # Cartoon and watercolor share one composition: themed backdrop, the
            # stylised portrait, then the pre-keyed frame PNG on top as a matte.
            # They differ only in how the portrait was rendered and, for
            # watercolor, in the backdrop being a plexus field rather than a fill.
            cartoon_subject = processed_stickers[0]["image"] if processed_stickers else None
            if cartoon_subject is None:
                raise HTTPException(status_code=400, detail=f"No photo provided for {processing_mode} mode")
            tri = raw_template_cfg.get("triangle", {}) or {}
            palette = get_theme(cartoon_theme)

            canvas_w = template_meta.width or 1080
            canvas_h = template_meta.height or 1350

            # Transparent artwork: everything the subject does not cover inside
            # the triangle is left clear, so the PNG can be laid over video or an
            # animated background. Mutually exclusive with a generated backdrop —
            # a plexus field IS a background, and drawing one then asking for
            # transparency would just make the transparency unreachable.
            transparent = bool(raw_template_cfg.get("transparentBackground", False))
            plexus_bg = None
            if (processing_mode == "watercolor" and not transparent
                    and raw_template_cfg.get("plexusBackground", False)):
                # Cached on (size, theme), so this is generated once per template
                # per process rather than per guest.
                plexus_bg = Image.fromarray(generate_plexus(canvas_w, canvas_h, cartoon_theme))
            # The theme owns backdrop + stroke so portrait, frame and background
            # stay in one hue family. A template may still pin an explicit stroke
            # colour, which wins over the theme's.
            final_image = compose_duotone_artwork(
                cartoon_subject,
                canvas_width=canvas_w,
                canvas_height=canvas_h,
                bg_color=palette["backdrop"],
                backdrop_image=plexus_bg,
                transparent=transparent,
                triangle_color=_hex_to_rgb(tri.get("color", ""), palette["triangle"]),
                apex_y_ratio=float(tri.get("apexYRatio", 0.10)),
                base_y_ratio=float(tri.get("baseYRatio", 0.90)),
                base_width_ratio=float(tri.get("baseWidthRatio", 0.92)),
                line_width=int(tri.get("lineWidth", 11)),
                glow_radius=int(tri.get("glowRadius", 34)),
                # The template PNG is a pre-keyed matte here, not a thumbnail: it
                # clips the portrait to the triangle and is the same file the
                # capture preview overlays, so preview and artwork cannot drift.
                frame_path=template_path,
                fit="frame" if guest_framed else "portrait",
            )
        else:
            # All other modes (sticker, frame, pre_extracted, magazine) use the standard composition service
            final_image = compose_service.compose_final(
                template_path=template_path,
                stickers=processed_stickers,
                template_meta=template_meta,
                processing_mode=processing_mode,
                user_position=user_position,
                fg_template_path=fg_template_path,
                magazine_name=magazine_name,
                magazine_designation=magazine_designation,
                overlay_name=overlay_name,
                overlay_designation=overlay_designation,
            )
        print(f"PERF:   compose:   {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # Save via StorageService — encode immediately, defer S3 upload
        t_step = time.perf_counter()
        import asyncio
        result, upload_fn = await storage_service.save_output_deferred(
            final_image,
            template_id=template_id,
            print_mode=template_meta.luggage_card_mode,
            output_format=template_meta.output_format,
            dpi=(template_meta.print_dpi, template_meta.print_dpi) if template_meta.luggage_card_mode else None,
        )
        print(f"PERF:   encode:    {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # Fire off S3 upload in background — user doesn't wait for it
        asyncio.create_task(upload_fn())

        # Cache the cutout for the "Adjust Sticker Placement" reuse path.
        if cutout_to_cache is not None:
            _cache_cutout(result.output_id, cutout_to_cache)

        # Track stats
        stats_service.increment_generation(processing_mode, template_id)

        # Record in jobs DB (non-blocking; failure must not affect the response)
        try:
            jobs_service.upsert(
                result.output_id,
                guest_name=guest_name,
                guest_phone=guest_phone,
                template_id=template_id,
                mode=processing_mode,
            )
        except Exception as je:
            print(f"WARNING: jobs_service.upsert failed: {je}", flush=True)

        print(f"PERF:   TOTAL:     {time.perf_counter() - t_total:.2f}s (upload runs in background)", flush=True)
        print(f"{'='*50}\n", flush=True)

        return GenerateResponse(
            success=True,
            output_id=result.output_id,
            output_url=result.share_url,
            download_url=result.download_url,
            error=None,
            processing_mode_used=processing_mode,
            output_format=("png" if str(getattr(template_meta, "output_format", "")).lower() == "png"
                           else "jpg"),
            transparent=bool(final_image.mode == "RGBA"),
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
        t_extract = time.perf_counter()
        photo_bytes = await photo.read()
        
        # 1. Remove background
        t_step = time.perf_counter()
        sticker_image = await rembg_service.remove_background(photo_bytes)
        print(f"PERF [extract]: rembg: {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # 2. Crop to alpha bbox (if not full_frame)
        t_step = time.perf_counter()
        sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode=anchor_mode)
        print(f"PERF [extract]: crop:  {time.perf_counter() - t_step:.2f}s", flush=True)
        
        # Save to buffer and return
        buf = BytesIO()
        sticker_image.save(buf, format="PNG")
        buf.seek(0)
        
        print(f"PERF [extract]: TOTAL: {time.perf_counter() - t_extract:.2f}s", flush=True)
        return Response(content=buf.getvalue(), media_type="image/png")

    except Exception as e:
        import traceback
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/cutout/{output_id}")
async def get_cutout(output_id: str):
    """
    Return the cached subject cutout (transparent PNG) from a prior generation.

    Powers "Adjust Sticker Placement": the editor reuses the exact cutout the
    user already saw instead of re-running background removal. Returns 404 when
    the cutout is no longer cached — callers must fall back to /api/extract.
    """
    cutout = _cutout_cache.get(output_id)
    if cutout is None:
        raise HTTPException(status_code=404, detail="Cutout not cached")

    _cutout_cache.move_to_end(output_id)  # mark as recently used
    buf = BytesIO()
    cutout.save(buf, format="PNG")
    buf.seek(0)
    return Response(content=buf.getvalue(), media_type="image/png")


@router.get("/download/{output_id}")
async def download_output(output_id: str, source: Optional[str] = None):
    """
    Download a generated output image.
    ?source=app marks the photo as downloaded (operator-confirmed handoff).
    QR / customer downloads omit source so downloaded_at is NOT set.
    """
    # Mark as downloaded only on explicit operator-initiated downloads
    if source == "app":
        try:
            jobs_service.mark_downloaded(output_id)
        except Exception as e:
            print(f"WARNING: mark_downloaded failed for {output_id}: {e}", flush=True)

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

    # Sniff the real encoding rather than assuming JPEG. An artwork PNG served
    # with image/jpeg and a .jpg filename is a corrupt download for the guest,
    # and silently loses exactly the transparency the mode exists to produce.
    is_png = image_bytes[:8] == b"\x89PNG\r\n\x1a\n"
    is_webp = image_bytes[:4] == b"RIFF" and image_bytes[8:12] == b"WEBP"
    ext = "png" if is_png else ("webp" if is_webp else "jpg")
    media = {"png": "image/png", "webp": "image/webp", "jpg": "image/jpeg"}[ext]

    return Response(
        content=image_bytes,
        media_type=media,
        headers={
            "Content-Disposition": f'attachment; filename="photobooth-{output_id}.{ext}"',
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
                            "compositeMode": meta.composite_mode,
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
