import asyncio
import os
import time
from io import BytesIO

from fastapi import APIRouter, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from PIL import Image

from schemas.wtm_schemas import (
    ComposeRequest, ComposeResponse, WordsResponse, WordItem, BundleItem
)
from schemas.wtm_schemas import GenerateResponse
from services.wtm_config import get_config
from services.wtm_composer import compose_template
from services.compose import compose_service, TemplateMetadata, SlotMetadata
from services.storage_service import storage_service
from services.stats_service import stats_service
from services.jobs_service import jobs_service

router = APIRouter(tags=['wtm'])


@router.get('/composed-image')
async def serve_composed_image(path: str):
    """Serve a composed WTM template PNG so the frontend edit screen can show it."""
    abs_path = os.path.abspath(path)
    if not os.path.exists(abs_path):
        raise HTTPException(status_code=404, detail='Composed template not found')
    return FileResponse(abs_path, media_type='image/png')


@router.get('/words/{template_id}', response_model=WordsResponse)
async def get_words(template_id: str):
    config = get_config(template_id)  # raises 400 if not found
    return WordsResponse(
        template_id=config['template_id'],
        words=[
            WordItem(
                id=w['id'],
                label=w['label'],
                svg_path=f"templates/wtm/{config['template_id']}/words/{w['svg_filename']}"
                    if w.get('svg_filename') else ''
            )
            for w in config['words']
        ],
        bundles=[
            BundleItem(id=b['id'], label=b['label'], words=b['words'])
            for b in config.get('bundles', [])
        ],
        max_selections=config['max_selections'],
        slot_count=len(config['slots']),
        allow_manual_positioning=config.get('allow_manual_positioning', True),
        has_name_overlay=bool(config.get('name_text')),
        has_designation_overlay=bool(config.get('designation_text')),
    )


@router.post('/generate', response_model=GenerateResponse)
async def wtm_generate(
    template_id: str = Form(...),
    composed_template_path: str = Form(...),
    photos: list[UploadFile] = File(...),
    photo_position: str = Form(None),      # JSON from PreviewEditScreen
    processing_mode: str = Form('sticker'), # 'sticker' or 'pre_extracted'
    wtm_name: str = Form(""),              # person's name (if name overlay configured)
    wtm_designation: str = Form(""),       # person's designation (if configured)
    guest_name: str = Form(""),            # Capture form: guest's name (optional)
    guest_phone: str = Form(""),           # Capture form: guest's phone (optional)
):
    """
    Composite a guest photo onto a WTM-composed template PNG.

    Correct flow:
    1. Validate composed_template_path exists on disk
    2. Remove background from user photo → transparent sticker PNG
    3. Crop sticker to alpha bbox, detect face landmarks (same as sticker pipeline)
    4. Load WTM config for dimensions
    5. Build TemplateMetadata with composite_mode='background'
       → WTM template is the solid background, sticker is placed on top
    6. Deferred S3 save
    """
    from services.rembg_service import rembg_service
    from services.face_service import face_service

    print(f"\n{'='*50}", flush=True)
    print(f"PERF: WTM Generate — template={template_id}", flush=True)
    t_total = time.perf_counter()

    try:
        # Resolve to absolute path (match sticker pipeline behavior — CWD-independent)
        composed_template_path = os.path.abspath(composed_template_path)

        # Validate composed path
        if not os.path.exists(composed_template_path):
            raise HTTPException(
                status_code=400,
                detail={'error_code': 'COMPOSED_PATH_NOT_FOUND',
                        'message': 'Composed template not found. Please re-compose.'}
            )

        # Load WTM config for dimensions
        config = get_config(template_id)
        w = config['dimensions']['width']
        h = config['dimensions']['height']

        # Parse optional manual position from PreviewEditScreen
        import json as _json
        user_position = None
        if photo_position:
            try:
                user_position = _json.loads(photo_position)
            except _json.JSONDecodeError:
                pass

        # Step 1: Get sticker — either from rembg or pre-extracted by the frontend
        photo = photos[0]
        photo_bytes = await photo.read()

        t_step = time.perf_counter()
        if processing_mode == 'pre_extracted':
            # Frontend already ran /api/extract — image is a transparent PNG
            sticker_image = Image.open(BytesIO(photo_bytes)).convert("RGBA")
            landmarks = None
            print(f"PERF:   pre_extracted (skip rembg): {time.perf_counter() - t_step:.2f}s", flush=True)
        else:
            sticker_image = await rembg_service.remove_background(photo_bytes)
            print(f"PERF:   rembg:     {time.perf_counter() - t_step:.2f}s", flush=True)

            # Step 2: Crop to alpha bbox (removes empty transparent padding)
            sticker_image = compose_service.crop_to_alpha_bbox(sticker_image, anchor_mode='bbox_center')

            # Step 3: Face detection on cropped sticker (for smart placement)
            t_step = time.perf_counter()
            landmarks = None
            try:
                landmarks = face_service.detect_landmarks(sticker_image)
                if landmarks:
                    print(f"DEBUG: Face detected in WTM sticker: {landmarks}", flush=True)
                else:
                    print(f"DEBUG: No face detected in WTM sticker", flush=True)
            except Exception as e:
                print(f"DEBUG: Face detection failed: {e}", flush=True)
            print(f"PERF:   face:      {time.perf_counter() - t_step:.2f}s", flush=True)

        # Step 4: Build TemplateMetadata using admin-defined photo_slot
        # composite_mode='background' → WTM template placed first as background,
        # then user's rembg cutout pasted on top into the photo_slot region.
        ps = config.get('photo_slot')
        if not ps:
            raise HTTPException(
                status_code=400,
                detail={
                    'error_code': 'NO_PHOTO_SLOT',
                    'message': 'No photo slot defined for this template. Please configure it in the admin.'
                }
            )

        from services.compose import MagazineTextConfig
        from utils.wtm_utils import find_font_path

        def _parse_wtm_text_cfg(raw: dict):
            if not raw:
                return None
            font_name = raw.get('font_name', '')
            font_path = find_font_path(font_name) or '' if font_name else ''
            return MagazineTextConfig(
                x=int(raw.get('x', 0)),
                y=int(raw.get('y', 0)),
                font_size=int(raw.get('font_size', 60)),
                color=raw.get('color', '#FFFFFF'),
                font_path=font_path,
                max_width=int(raw.get('max_width', 0)),
                align=raw.get('align', 'left'),
                uppercase=bool(raw.get('uppercase', False)),
            )

        template_meta = TemplateMetadata(
            template_id=template_id,
            name=config.get('name', 'WTM Template'),
            png_path=composed_template_path,
            slots=[SlotMetadata(
                slot_id='photo',
                x=ps['x'],
                y=ps['y'],
                width=ps['width'],
                height=ps['height'],
                anchor_target_x=ps.get('anchor_x', 0.5),    # relative 0-1 within slot
                anchor_target_y=ps.get('anchor_y', 0.35),
                z_index=0,
                desired_face_ratio=ps.get('desired_face_ratio', 0.35),
                min_zoom=ps.get('min_zoom', 0.5),
                max_zoom=ps.get('max_zoom', 3.0),
            )],
            anchor_mode=ps.get('anchor_mode', 'face_center'),
            width=w,
            height=h,
            template_type='sticker',
            composite_mode='background',
            sticker_filter=ps.get('sticker_filter', 'none'),
            name_text=_parse_wtm_text_cfg(config.get('name_text', {})),
            designation_text=_parse_wtm_text_cfg(config.get('designation_text', {})),
        )

        stickers = [{'image': sticker_image, 'landmarks': landmarks}]

        # Step 5: Compose — WTM template as background, sticker on top
        # compose_final() only understands 'sticker' | 'pre_extracted' | 'frame'.
        # The form field processing_mode='word_template' is a routing hint from the
        # frontend — map it to the correct internal compose mode here.
        compose_mode = 'pre_extracted' if processing_mode == 'pre_extracted' else 'sticker'
        t_step = time.perf_counter()
        final_image = compose_service.compose_final(
            template_path=composed_template_path,
            stickers=stickers,
            template_meta=template_meta,
            processing_mode=compose_mode,
            user_position=user_position,
            magazine_name=wtm_name,
            magazine_designation=wtm_designation,
        )
        print(f"PERF:   compose:   {time.perf_counter() - t_step:.2f}s", flush=True)

        # Save — encode immediately, defer S3 upload to background
        t_step = time.perf_counter()
        result, upload_fn = await storage_service.save_output_deferred(
            final_image, template_id=template_id
        )
        print(f"PERF:   encode:    {time.perf_counter() - t_step:.2f}s", flush=True)

        asyncio.create_task(upload_fn())

        stats_service.increment_generation('word_template', template_id)

        try:
            jobs_service.upsert(
                result.output_id,
                guest_name=guest_name,
                guest_phone=guest_phone,
                template_id=template_id,
                mode='word_template',
            )
        except Exception as je:
            print(f"WARNING: jobs_service.upsert failed: {je}", flush=True)

        print(f"PERF:   TOTAL:     {time.perf_counter() - t_total:.2f}s (upload in background)", flush=True)
        print(f"{'='*50}\n", flush=True)

        return GenerateResponse(
            success=True,
            output_id=result.output_id,
            output_url=result.share_url,
            download_url=result.download_url,
            processing_mode_used='word_template',
        )

    except HTTPException:
        raise
    except Exception as e:
        import traceback
        traceback.print_exc()
        return GenerateResponse(success=False, error=str(e))



@router.post('/compose', response_model=ComposeResponse)
async def compose(req: ComposeRequest):
    config = get_config(req.template_id)

    valid_ids = {w['id'] for w in config['words']}
    invalid = [w for w in req.selected_words if w not in valid_ids]
    if invalid:
        raise HTTPException(
            status_code=400,
            detail={
                'error_code': 'WORD_NOT_FOUND',
                'message': 'Unknown word IDs',
                'invalid_ids': invalid
            }
        )

    if len(req.selected_words) > len(config['slots']):
        raise HTTPException(
            status_code=400,
            detail={
                'error_code': 'SLOT_COUNT_MISMATCH',
                'message': (
                    f"Selected {len(req.selected_words)} words "
                    f"but template only has {len(config['slots'])} slots"
                )
            }
        )

    try:
        return await compose_template(config, req.selected_words)
    except asyncio.TimeoutError:
        raise HTTPException(
            status_code=500,
            detail={'error_code': 'COMPOSE_FAILED', 'message': 'Compositing timed out'}
        )
    except Exception:
        raise HTTPException(
            status_code=500,
            detail={'error_code': 'COMPOSE_FAILED', 'message': 'Compositing failed'}
        )
