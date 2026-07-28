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
