"""
Background Removal Service
==========================
Handles background removal from user photos using open-source AI models.

Phase 1: rembg with U²-Net / IS-Net (free, self-hostable)
Future: Remove.bg API fallback for premium quality
"""

from PIL import Image
from io import BytesIO
from typing import Optional
from rembg import remove


class BackgroundRemovalService:
    """
    Service for removing backgrounds from photos.
    
    This service abstracts the background removal implementation,
    allowing easy switching between providers:
    - rembg (default, free, open-source)
    - Remove.bg API (future paid option)
    """
    
    def __init__(self, provider: str = "rembg"):
        """
        Initialize the background removal service.
        
        Args:
            provider: Which provider to use ("rembg" or "removebg")
        """
        self.provider = provider
        self._model_loaded = False
    
    def _ensure_model_loaded(self):
        """
        Lazy-load the rembg model on first use.
        
        Note: rembg downloads U²-Net model on first run (~170MB).
        This is cached in ~/.u2net/ for subsequent runs.
        """
        if not self._model_loaded:
            # Model will be loaded on first remove() call
            self._model_loaded = True
    
    async def remove_background(
        self,
        image_bytes: bytes,
        alpha_matting: bool = False,
    ) -> Image.Image:
        """
        Remove the background from an image.
        
        Args:
            image_bytes: Raw bytes of the input image (JPEG, PNG, etc.)
            alpha_matting: Use alpha matting for finer edge details
                          (slower but better for hair/fur)
        
        Returns:
            PIL Image with transparent background (RGBA mode)
        """
        self._ensure_model_loaded()
        
        # Open input image
        input_image = Image.open(BytesIO(image_bytes))
        
        # Remove background using rembg
        if alpha_matting:
            output_image = remove(
                input_image,
                alpha_matting=True,
                alpha_matting_foreground_threshold=240,
                alpha_matting_background_threshold=10,
            )
        else:
            output_image = remove(input_image)
        
        return output_image
    
    async def remove_background_removebg(
        self,
        image_bytes: bytes,
        api_key: str,
    ) -> Image.Image:
        """
        Remove background using Remove.bg API (paid service).
        
        This is a future upgrade path for:
        - Higher quality results
        - Better handling of complex scenes
        - API-level SLA guarantees
        
        Args:
            image_bytes: Raw bytes of the input image
            api_key: Remove.bg API key
        
        Returns:
            PIL Image with transparent background
        
        Note:
            Remove.bg charges per image. Use for premium tier only.
            Current pricing: ~$0.20-0.99 per image depending on resolution.
        """
        # TODO: Implement Remove.bg API integration
        # import requests
        # response = requests.post(
        #     "https://api.remove.bg/v1.0/removebg",
        #     files={"image_file": image_bytes},
        #     data={"size": "auto"},
        #     headers={"X-Api-Key": api_key},
        # )
        # return Image.open(BytesIO(response.content))
        
        raise NotImplementedError("Remove.bg integration not yet implemented")


# Singleton instance for use across the application
rembg_service = BackgroundRemovalService()
