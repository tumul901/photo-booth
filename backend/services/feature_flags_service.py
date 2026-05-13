"""
Feature Flags Service
=====================
Persists a flat dict of feature flags to disk and serves them to admin UI + booth.

Stored in backend/data/feature_flags.json. Hot-reloadable — admin changes take
effect on the very next request from the booth, no restart needed.

Flags currently tracked:
- modes.frame / modes.sticker / modes.word_template / modes.magazine — visibility
  of the mode cards on the booth StartScreen
- rembg_profile — which segmentation profile rembg_service uses
  ('isnet_hi' or 'silueta_hi'); see services/rembg_service.py for definitions
"""

import json
import logging
import threading
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
FLAGS_PATH = DATA_DIR / "feature_flags.json"

DEFAULTS: dict[str, Any] = {
    "modes": {
        "frame": True,
        "sticker": True,
        "word_template": True,
        "magazine": True,
    },
    "rembg_profile": "isnet_hi",
    "sticker_effect": "none",
    "sticker_stroke_color": "#FFFFFF",
    "sticker_stroke_width": 4,
}

# Valid rembg profile names. Kept in lockstep with services/rembg_service.PROFILES.
# Duplicated here (instead of imported) to avoid a circular import — rembg_service
# imports get_rembg_profile() from this module on every cutout call.
PROFILES_NAMES = ("isnet_hi", "silueta_hi")

# Valid sticker edge effect names. Mirror of sticker_effects.EFFECT_NAMES; duplicated
# here for the same circular-import reason.
STICKER_EFFECT_NAMES = ("none", "stroke", "shadow", "unsharp", "alpha_matting")

_lock = threading.Lock()
_cache: dict[str, Any] | None = None


def _deep_merge(base: dict, override: dict) -> dict:
    """Merge override into base, recursively, preserving keys from base not in override."""
    out = dict(base)
    for k, v in override.items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _deep_merge(out[k], v)
        else:
            out[k] = v
    return out


def _load_from_disk() -> dict[str, Any]:
    if not FLAGS_PATH.exists():
        return dict(DEFAULTS)
    try:
        with open(FLAGS_PATH, "r", encoding="utf-8") as f:
            raw = json.load(f)
        return _deep_merge(DEFAULTS, raw if isinstance(raw, dict) else {})
    except Exception as e:
        logger.error(f"feature_flags: failed to load {FLAGS_PATH}: {e}; using defaults")
        return dict(DEFAULTS)


def get_flags() -> dict[str, Any]:
    """Return the current flags (cached, hot-reloads on save)."""
    global _cache
    if _cache is None:
        with _lock:
            if _cache is None:
                _cache = _load_from_disk()
    return _cache


def save_flags(new_flags: dict[str, Any]) -> dict[str, Any]:
    """Merge new_flags into the existing flags, persist, and return the merged result."""
    global _cache
    with _lock:
        current = _cache if _cache is not None else _load_from_disk()
        merged = _deep_merge(current, new_flags)
        DATA_DIR.mkdir(parents=True, exist_ok=True)
        with open(FLAGS_PATH, "w", encoding="utf-8") as f:
            json.dump(merged, f, indent=2)
        _cache = merged
    return merged


def get_rembg_profile() -> str:
    return get_flags().get("rembg_profile", DEFAULTS["rembg_profile"])


def get_sticker_effect() -> str:
    return get_flags().get("sticker_effect", DEFAULTS["sticker_effect"])


def get_sticker_stroke_color() -> str:
    return get_flags().get("sticker_stroke_color", DEFAULTS["sticker_stroke_color"])


def get_sticker_stroke_width() -> int:
    return int(get_flags().get("sticker_stroke_width", DEFAULTS["sticker_stroke_width"]))
