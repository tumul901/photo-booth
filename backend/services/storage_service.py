"""
Storage Service
===============
Handles saving generated images and providing QR-ready shareable URLs.

This service abstracts storage providers to allow easy switching:
- Local filesystem (development)
- Cloud storage (production: S3, GCS, Azure Blob)
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from typing import Optional
from PIL import Image
from io import BytesIO
import uuid
import os
from datetime import datetime


@dataclass
class StorageResult:
    """Result from saving an image to storage."""
    output_id: str
    download_url: str  # Direct image download URL
    share_url: str  # QR-ready shareable page URL
    expires_at: Optional[datetime] = None


class StorageProvider(ABC):
    """Abstract base class for storage providers."""
    
    @abstractmethod
    async def save_image(
        self,
        image: Image.Image,
        filename: Optional[str] = None,
        format: str = "PNG",
    ) -> StorageResult:
        """
        Save an image and return URLs for access.
        
        Args:
            image: PIL Image to save
            filename: Optional custom filename (generated if not provided)
            format: Image format (PNG, JPEG, WEBP)
        
        Returns:
            StorageResult with download and share URLs
        """
        pass
    
    @abstractmethod
    async def get_image(self, output_id: str) -> Optional[bytes]:
        """
        Retrieve an image by its output ID.
        
        Args:
            output_id: Unique identifier for the image
        
        Returns:
            Image bytes or None if not found
        """
        pass
    
    @abstractmethod
    async def delete_image(self, output_id: str) -> bool:
        """
        Delete an image by its output ID.
        
        Args:
            output_id: Unique identifier for the image
        
        Returns:
            True if deleted, False if not found
        """
        pass


class LocalStorageProvider(StorageProvider):
    """
    Local filesystem storage for development.
    
    Stores images in the outputs/ directory.
    URLs point to the local API server.
    """
    
    def __init__(
        self,
        output_dir: str = "outputs",
        base_url: str = "http://localhost:8000",
    ):
        """
        Initialize local storage provider.
        
        Args:
            output_dir: Directory to store output images
            base_url: Base URL for generating access URLs
        """
        self.output_dir = output_dir
        self.base_url = base_url
        os.makedirs(output_dir, exist_ok=True)
    
    async def save_image(
        self,
        image: Image.Image,
        filename: Optional[str] = None,
        format: str = "PNG",
    ) -> StorageResult:
        """Save image to local filesystem."""
        output_id = filename or f"{uuid.uuid4().hex}"
        file_ext = format.lower()
        filepath = os.path.join(self.output_dir, f"{output_id}.{file_ext}")
        
        # TODO: Implement actual save
        # image.save(filepath, format=format, optimize=True)
        
        return StorageResult(
            output_id=output_id,
            download_url=f"{self.base_url}/api/download/{output_id}.{file_ext}",
            share_url=f"{self.base_url}/share/{output_id}",
        )
    
    async def get_image(self, output_id: str) -> Optional[bytes]:
        """Retrieve image from local filesystem."""
        # TODO: Implement file lookup
        # for ext in ["png", "jpg", "webp"]:
        #     filepath = os.path.join(self.output_dir, f"{output_id}.{ext}")
        #     if os.path.exists(filepath):
        #         with open(filepath, "rb") as f:
        #             return f.read()
        return None
    
    async def delete_image(self, output_id: str) -> bool:
        """Delete image from local filesystem."""
        # TODO: Implement deletion
        return False


class CloudStorageProvider(StorageProvider):
    """
    Cloud storage provider for production.
    
    Supports:
    - AWS S3
    - Google Cloud Storage
    - Azure Blob Storage
    
    Features:
    - Signed URLs for secure access
    - CDN integration for fast global delivery
    - Automatic expiration for storage cost management
    """
    
    def __init__(
        self,
        provider: str,  # "s3", "gcs", "azure"
        bucket: str,
        base_cdn_url: Optional[str] = None,
        share_base_url: str = "https://app.example.com",
    ):
        """
        Initialize cloud storage provider.
        
        Args:
            provider: Cloud provider type
            bucket: Bucket/container name
            base_cdn_url: Optional CDN URL for downloads
            share_base_url: Base URL for share pages
        """
        self.provider = provider
        self.bucket = bucket
        self.base_cdn_url = base_cdn_url
        self.share_base_url = share_base_url
    
    async def save_image(
        self,
        image: Image.Image,
        filename: Optional[str] = None,
        format: str = "PNG",
    ) -> StorageResult:
        """
        Save image to cloud storage.
        
        TODO: Implement cloud upload
        - Generate signed upload URL
        - Upload image bytes
        - Return CDN URL for downloads
        - Return share page URL for QR codes
        """
        output_id = filename or f"{uuid.uuid4().hex}"
        
        # Placeholder URLs
        return StorageResult(
            output_id=output_id,
            download_url=f"{self.base_cdn_url or 'https://cdn.example.com'}/{output_id}.png",
            share_url=f"{self.share_base_url}/share/{output_id}",
            expires_at=None,  # TODO: Implement expiration
        )
    
    async def get_image(self, output_id: str) -> Optional[bytes]:
        """Retrieve image from cloud storage."""
        # TODO: Implement cloud download
        raise NotImplementedError("Cloud storage not yet implemented")
    
    async def delete_image(self, output_id: str) -> bool:
        """Delete image from cloud storage."""
        # TODO: Implement cloud deletion
        raise NotImplementedError("Cloud storage not yet implemented")


class StorageService:
    """
    High-level storage service that handles provider selection.
    
    Usage:
        storage = StorageService()
        result = await storage.save_output(composited_image)
        print(f"QR URL: {result.share_url}")
    """
    
    def __init__(self, provider: Optional[StorageProvider] = None):
        """
        Initialize storage service.
        
        Args:
            provider: Storage provider instance. Defaults to LocalStorageProvider.
        """
        self.provider = provider or LocalStorageProvider()
    
    async def save_output(
        self,
        image: Image.Image,
        template_id: Optional[str] = None,
        metadata: Optional[dict] = None,
    ) -> StorageResult:
        """
        Save a generated output image.
        
        Args:
            image: The final composited image
            template_id: Optional template ID for metadata
            metadata: Optional additional metadata to store
        
        Returns:
            StorageResult with URLs ready for QR code generation
        
        Note:
            The share_url is specifically designed to be:
            - Short and QR-friendly
            - Landing page with download option
            - Optimized for mobile viewing
        """
        # Generate unique ID with optional template prefix
        prefix = f"{template_id[:8]}-" if template_id else ""
        output_id = f"{prefix}{uuid.uuid4().hex[:12]}"
        
        result = await self.provider.save_image(image, output_id)
        
        # TODO: Store metadata alongside image for retrieval
        # This would include template_id, creation time, etc.
        
        return result
    
    async def get_output(self, output_id: str) -> Optional[bytes]:
        """Retrieve a previously saved output."""
        return await self.provider.get_image(output_id)
    
    async def delete_output(self, output_id: str) -> bool:
        """Delete a saved output."""
        return await self.provider.delete_image(output_id)


# Singleton instance (configured for local development)
storage_service = StorageService()
