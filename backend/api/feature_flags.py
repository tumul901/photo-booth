"""
Feature Flags API
=================
Public GET endpoint for the booth (so it knows which mode cards to show)
and an admin PUT endpoint to update them at runtime.

Both endpoints serve the same flat dict shape — see feature_flags_service.DEFAULTS.
"""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Any

from services.feature_flags_service import (
    get_flags,
    save_flags,
    PROFILES_NAMES,
    STICKER_EFFECT_NAMES,
)

router = APIRouter(tags=["feature-flags"])


class FlagsUpdate(BaseModel):
    """Partial update — only keys present in the body are merged into the existing flags."""
    modes: dict[str, bool] | None = None
    rembg_profile: str | None = None
    sticker_effect: str | None = None
    sticker_stroke_color: str | None = None
    sticker_stroke_width: int | None = None


@router.get("/feature-flags")
async def public_get_flags():
    """Booth reads this on the StartScreen to decide which mode cards to render."""
    return get_flags()


@router.get("/admin/feature-flags")
async def admin_get_flags():
    """Admin UI fetches the full flags dict here (same payload as the public endpoint,
    but routed under /api/admin for clarity)."""
    return {
        "flags": get_flags(),
        "available_rembg_profiles": list(PROFILES_NAMES),
        "available_sticker_effects": list(STICKER_EFFECT_NAMES),
    }


@router.put("/admin/feature-flags")
async def admin_put_flags(body: FlagsUpdate):
    """
    Merge the given keys into the persisted flags. Examples:
      { "modes": { "word_template": false } }
      { "rembg_profile": "silueta_hi" }
      { "sticker_effect": "stroke" }
    """
    update: dict[str, Any] = {}
    if body.modes is not None:
        update["modes"] = body.modes
    if body.rembg_profile is not None:
        if body.rembg_profile not in PROFILES_NAMES:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown rembg_profile '{body.rembg_profile}'. "
                       f"Available: {sorted(PROFILES_NAMES)}",
            )
        update["rembg_profile"] = body.rembg_profile
    if body.sticker_effect is not None:
        if body.sticker_effect not in STICKER_EFFECT_NAMES:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown sticker_effect '{body.sticker_effect}'. "
                       f"Available: {sorted(STICKER_EFFECT_NAMES)}",
            )
        update["sticker_effect"] = body.sticker_effect
    if body.sticker_stroke_color is not None:
        # Basic validation: must start with '#' and be 4 or 7 chars (e.g. #FFF or #FFFFFF)
        c = body.sticker_stroke_color.strip()
        if not (c.startswith("#") and len(c) in (4, 7)):
            raise HTTPException(
                status_code=400,
                detail=f"Invalid stroke color '{c}'. Use hex format like #FFFFFF or #FFF.",
            )
        update["sticker_stroke_color"] = c
    if body.sticker_stroke_width is not None:
        w = body.sticker_stroke_width
        if not (1 <= w <= 20):
            raise HTTPException(
                status_code=400,
                detail=f"Stroke width must be between 1 and 20 (got {w}).",
            )
        update["sticker_stroke_width"] = w

    if not update:
        raise HTTPException(status_code=400, detail="No flags provided to update")

    merged = save_flags(update)
    return {"ok": True, "flags": merged}
