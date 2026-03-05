"""
Background Removal Service
==========================
Handles background removal from user photos using open-source AI models.

Performance notes:
- Uses "silueta" model (~4MB) instead of default "u2net" (~170MB).
  Silueta is optimized for human silhouettes → ideal for a photobooth.
  Runs ~3-5× faster with comparable quality for people.
- rembg.remove() is CPU-bound. We use asyncio.to_thread() so the
  FastAPI event loop is NOT blocked during inference.
- Input images are downsized to max 1200px before processing.
- A persistent session is created once and reused for all requests.
- The model is pre-warmed on startup to avoid a cold-start penalty.
"""

import asyncio
from PIL import Image
from io import BytesIO
from typing import Optional
from rembg import remove, new_session

# Model choice: "silueta" is ~4MB, fast, and great for people.
# Alternatives: "u2netp" (also fast), "u2net" (slow but best quality),
#               "isnet-general-use" (good balance).
REMBG_MODEL = "silueta"

# Max dimension (width or height) before feeding into rembg.
# Larger images are proportionally downsized. This cuts rembg
# inference time by 3-5× for typical phone camera photos.
MAX_INPUT_DIMENSION = 1200


class BackgroundRemovalService:
    """
    Service for removing backgrounds from photos.
    
    Key performance design:
    - Uses a persistent rembg session with the lightweight "silueta" model.
    - rembg.remove() runs in a thread (asyncio.to_thread) so the event
      loop stays responsive for other requests during inference.
    - Input images are downsized to MAX_INPUT_DIMENSION before processing.
    - Model is pre-warmed on startup via warm_up().
    """
    
    def __init__(self, provider: str = "rembg"):
        self.provider = provider
        self._session = None
        self._model_loaded = False
    
    def warm_up(self):
        """
        Eagerly load the rembg model by creating a session and running
        a tiny dummy image. Call this at app startup.
        """
        if self._model_loaded:
            return
        print(f"INFO: Pre-warming rembg model ({REMBG_MODEL})...", flush=True)
        self._session = new_session(REMBG_MODEL)
        dummy = Image.new("RGB", (64, 64), (128, 128, 128))
        remove(dummy, session=self._session)
        self._model_loaded = True
        print(f"INFO: rembg model ({REMBG_MODEL}) warm-up complete ✅", flush=True)

    def _ensure_session(self):
        """Create session if warm_up wasn't called (e.g. in dev)."""
        if self._session is None:
            self._session = new_session(REMBG_MODEL)

    @staticmethod
    def _downsize_image(image: Image.Image, max_dim: int) -> Image.Image:
        """
        Proportionally downsize an image so its longest side <= max_dim.
        Returns the original image untouched if already small enough.
        Uses BILINEAR for speed (input will be processed by rembg, not shown).
        """
        w, h = image.size
        if w <= max_dim and h <= max_dim:
            return image
        
        scale = max_dim / max(w, h)
        new_w = int(w * scale)
        new_h = int(h * scale)
        print(f"INFO: Downsizing input {w}×{h} → {new_w}×{new_h} before rembg", flush=True)
        return image.resize((new_w, new_h), Image.Resampling.BILINEAR)

    def _remove_sync(
        self,
        input_image: Image.Image,
        alpha_matting: bool = False,
    ) -> Image.Image:
        """
        Synchronous background removal (runs inside a thread).
        Uses persistent session for faster inference.
        """
        self._ensure_session()
        if alpha_matting:
            return remove(
                input_image,
                session=self._session,
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=10,
            )
        return remove(input_image, session=self._session)

    async def remove_background(
        self,
        image_bytes: bytes,
        alpha_matting: bool = False,
    ) -> Image.Image:
        """
        Remove the background from an image.
        
        The heavy CPU work is offloaded to a thread via asyncio.to_thread()
        so the FastAPI event loop remains responsive for other requests.
        
        Args:
            image_bytes: Raw bytes of the input image (JPEG, PNG, etc.)
            alpha_matting: Use alpha matting for finer edge details
        
        Returns:
            PIL Image with transparent background (RGBA mode)
        """
        # Open and downsize input
        input_image = Image.open(BytesIO(image_bytes))
        input_image = self._downsize_image(input_image, MAX_INPUT_DIMENSION)
        
        # Run CPU-bound inference in a thread to avoid blocking the event loop
        output_image = await asyncio.to_thread(
            self._remove_sync, input_image, alpha_matting
        )
        
        return output_image


# Singleton instance for use across the application
rembg_service = BackgroundRemovalService()
