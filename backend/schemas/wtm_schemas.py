from pydantic import BaseModel, field_validator, Field
from typing import List, Optional, Literal
import re


# ── Guest-facing models ────────────────────────────────────────────────

class ComposeRequest(BaseModel):
    template_id: str = Field(..., pattern=r'^[a-zA-Z0-9_-]+$')
    selected_words: List[str] = Field(..., min_length=1, max_length=6)

    @field_validator('selected_words')
    @classmethod
    def deduplicate_and_sort(cls, v):
        # Deduplicate silently, then sort for deterministic cache key
        return sorted(list(set(v)))

    @field_validator('selected_words')
    @classmethod
    def word_id_format(cls, v):
        for word in v:
            if not re.match(r'^[a-z0-9-]+$', word):
                raise ValueError(f'Invalid word ID format: {word}')
        return v

class ComposeResponse(BaseModel):
    template_path: str
    cache_hit: bool
    compose_time_ms: Optional[int] = None  # None on cache hit

class WordItem(BaseModel):
    id: str
    label: str
    svg_path: str = ''  # server-side path — frontend never uses this

class BundleItem(BaseModel):
    id: str
    label: str
    words: List[str]

class WordsResponse(BaseModel):
    template_id: str
    words: List[WordItem]
    bundles: List[BundleItem]
    max_selections: int = 6
    slot_count: int
    allow_manual_positioning: bool = True
    has_name_overlay: bool = False
    has_designation_overlay: bool = False

class WTMError(BaseModel):
    error_code: str
    message: str
    detail: Optional[str] = None


# ── Admin models ───────────────────────────────────────────────────────

class SlotDefinition(BaseModel):
    id: str = Field(..., pattern=r'^[a-zA-Z0-9_]+$')
    order: int = Field(..., ge=0)
    x: int = Field(..., ge=0)
    y: int = Field(..., ge=0)
    width: int = Field(..., ge=50)     # 50px minimum — matches TemplateEditor.tsx threshold
    height: int = Field(..., ge=50)    # 50px minimum — matches TemplateEditor.tsx threshold
    rotation: float = Field(0.0, ge=-180.0, le=180.0)  # degrees, clockwise positive

class SaveSlotsRequest(BaseModel):
    slots: List[SlotDefinition] = Field(..., min_length=1, max_length=6)

class PhotoSlotDefinition(BaseModel):
    x: int = Field(..., ge=0)
    y: int = Field(..., ge=0)
    width: int = Field(..., ge=50)
    height: int = Field(..., ge=50)
    anchor_x: float = Field(0.5, ge=0.0, le=1.0)   # relative within slot
    anchor_y: float = Field(0.35, ge=0.0, le=1.0)  # relative within slot
    anchor_mode: str = Field('face_center')          # face_center | eyes | none | full_frame
    desired_face_ratio: float = Field(0.35, gt=0.0, le=1.0)
    min_zoom: float = Field(0.5, gt=0.0)
    max_zoom: float = Field(3.0, gt=0.0)
    sticker_filter: str = Field('none')              # none | bw | sketch

class SavePhotoSlotRequest(BaseModel):
    photo_slot: PhotoSlotDefinition

class BundleDefinition(BaseModel):
    id: str
    label: str
    words: List[str] = Field(..., max_length=6)

class SaveSettingsRequest(BaseModel):
    allow_manual_positioning: bool = True
    max_selections: int = Field(6, ge=1, le=6)

class SaveBundlesRequest(BaseModel):
    bundles: List[BundleDefinition]

class WTMTemplateListItem(BaseModel):
    template_id: str
    name: str
    slot_count: int
    word_count: int
    created_at: str


class GenerateResponse(BaseModel):
    success: bool
    output_url: Optional[str] = None
    download_url: Optional[str] = None
    output_id: Optional[str] = None
    error: Optional[str] = None
    processing_mode_used: Optional[str] = None


class TextOverlayConfig(BaseModel):
    x: int
    y: int
    font_size: int
    color: str = "#FFFFFF"
    font_name: str = ""   # stem like "Roboto-Bold", resolved to abs path at render time
    max_width: int = 0
    align: str = "left"
    uppercase: bool = False

class SaveTextOverlayRequest(BaseModel):
    field: Literal["name_text", "designation_text"]
    config: Optional[TextOverlayConfig] = None  # None = remove overlay
