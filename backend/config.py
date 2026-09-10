"""
Application Configuration
=========================
Central configuration using pydantic-settings.
Reads from .env file automatically. All defaults are local-dev friendly.
"""

from pydantic_settings import BaseSettings
from typing import Optional


class Settings(BaseSettings):
    """
    Application settings. Override via environment variables or .env file.
    
    For local development, no .env file is needed — all defaults work.
    For production/S3, set STORAGE_PROVIDER=s3 and provide AWS_* variables.
    """

    # --- General ---
    BASE_URL: str = "http://localhost:8000"
    FRONTEND_URL: str = "http://localhost:3000"

    # --- Storage ---
    STORAGE_PROVIDER: str = "local"  # "local" or "s3"

    # --- AWS S3 (only needed when STORAGE_PROVIDER=s3) ---
    AWS_ACCESS_KEY_ID: Optional[str] = None
    AWS_SECRET_ACCESS_KEY: Optional[str] = None
    AWS_S3_BUCKET_NAME: Optional[str] = None
    AWS_REGION: str = "ap-south-1"
    AWS_S3_CDN_URL: Optional[str] = None  # Optional CloudFront/CDN URL

    # --- fal.ai (cloud background removal; the cloud_birefnet_* rembg profiles) ---
    # With no FAL_KEY those profiles fall back to the local model automatically,
    # so leaving this unset is safe.
    FAL_KEY: Optional[str] = None
    FAL_ENDPOINT: str = "https://fal.run/fal-ai/birefnet/v2"
    FAL_TIMEOUT_S: float = 12.0

    # --- Self-hosted BiRefNet box (the selfhost_birefnet rembg profile) ---
    # Base URL of our own GPU service, e.g. "https://bg.exlgobeyond.com" — point
    # this at the NLB, not an instance IP, so adding a second box needs no change
    # here. Unset means the profile falls back to local per request, same as fal.
    BG_SERVICE_URL: Optional[str] = None

    # Split into connect + read because they fail for different reasons and want
    # different patience. A box that is down refuses the connection in under a
    # second, and waiting the full read timeout for that just delays the guest's
    # fallback. A box that is merely busy has already accepted the connection and
    # is queuing — that one deserves the longer wait.
    #
    # 15 s for the read: comfortably above a warm cutout (~1-4 s, and ~2.1 req/s
    # sustained under load) and deliberately BELOW the ~26 s a freshly restarted
    # box takes on its first inference while CUDA autotunes. Sitting through that
    # cold window would cost every guest in it 26 seconds; timing out hands them
    # a local cutout in ~1.4 s instead. See the warm-up section of the service's
    # README — /health goes green about 26 s before the box can really serve.
    BG_SERVICE_TIMEOUT_S: float = 15.0
    BG_SERVICE_CONNECT_TIMEOUT_S: float = 5.0

    # Ask for the packed JPEG+PNG body (response_type=split) instead of one RGBA
    # PNG: ~5.6x smaller over the venue uplink and ~8.5x cheaper for the box to
    # encode, for a shape that is bit-identical. Set false to force plain PNG if
    # a proxy ever mangles the binary body.
    BG_SERVICE_SPLIT: bool = True

    # --- Paths ---
    OUTPUTS_DIR: str = "outputs"
    WTM_TEMPLATES_DIR: str = "templates/wtm"
    WTM_CACHE_DIR: str = "templates/wtm_cache"



    # --- Admin Credentials ---
    ADMIN_USERNAME: str = "admin"
    ADMIN_PASSWORD: str = "photobooth123"

    model_config = {
        "env_file": ".env",
        "env_file_encoding": "utf-8",
        "extra": "ignore",
    }


settings = Settings()
