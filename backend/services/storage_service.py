"""
Storage Service
===============
Handles saving generated images and providing QR-ready shareable URLs.

This service abstracts storage providers to allow easy switching:
- Local filesystem (development)
- AWS S3 (production)
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

    def get_local_path(self, output_id: str) -> Optional[str]:
        """
        Get local filesystem path for an output (if applicable).
        Only meaningful for LocalStorageProvider; returns None for cloud.
        """
        return None


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
        
        # Save the image to disk
        image.save(filepath, format=format, optimize=True)
        
        return StorageResult(
            output_id=output_id,
            download_url=f"{self.base_url}/api/download/{output_id}",
            share_url=f"{self.base_url}/api/share/{output_id}",
        )
    
    async def get_image(self, output_id: str) -> Optional[bytes]:
        """Retrieve image from local filesystem."""
        for ext in ["png", "jpg", "jpeg", "webp"]:
            filepath = os.path.join(self.output_dir, f"{output_id}.{ext}")
            if os.path.exists(filepath):
                with open(filepath, "rb") as f:
                    return f.read()
        return None
    
    async def delete_image(self, output_id: str) -> bool:
        """Delete image from local filesystem."""
        for ext in ["png", "jpg", "jpeg", "webp"]:
            filepath = os.path.join(self.output_dir, f"{output_id}.{ext}")
            if os.path.exists(filepath):
                os.remove(filepath)
                return True
        return False

    def get_local_path(self, output_id: str) -> Optional[str]:
        """Get local path to an output image file."""
        for ext in ["png", "jpg", "jpeg", "webp"]:
            filepath = os.path.join(self.output_dir, f"{output_id}.{ext}")
            if os.path.exists(filepath):
                return filepath
        return None


class S3StorageProvider(StorageProvider):
    """
    AWS S3 storage provider for production.
    
    Features:
    - Direct upload to S3
    - Public-read or presigned URLs for downloads
    - Optional CDN (CloudFront) URL support
    """
    
    def __init__(
        self,
        bucket: str,
        region: str = "ap-south-1",
        access_key_id: Optional[str] = None,
        secret_access_key: Optional[str] = None,
        cdn_url: Optional[str] = None,
        base_url: str = "http://localhost:8000",
    ):
        """
        Initialize S3 storage provider.
        
        Args:
            bucket: S3 bucket name
            region: AWS region
            access_key_id: AWS access key (uses env/IAM role if None)
            secret_access_key: AWS secret key (uses env/IAM role if None)
            cdn_url: Optional CloudFront CDN URL for downloads
            base_url: API base URL for share page links
        """
        import boto3

        self.bucket = bucket
        self.region = region
        self.cdn_url = cdn_url
        self.base_url = base_url
        self.prefix = "outputs/"  # S3 key prefix

        # Build boto3 client kwargs
        client_kwargs = {"region_name": region}
        if access_key_id and secret_access_key:
            client_kwargs["aws_access_key_id"] = access_key_id
            client_kwargs["aws_secret_access_key"] = secret_access_key

        self.s3 = boto3.client("s3", **client_kwargs)
        print(f"INFO: S3 storage initialized — bucket={bucket}, region={region}", flush=True)
    
    async def save_image(
        self,
        image: Image.Image,
        filename: Optional[str] = None,
        format: str = "PNG",
    ) -> StorageResult:
        """Save image to S3."""
        output_id = filename or f"{uuid.uuid4().hex}"
        file_ext = format.lower()
        s3_key = f"{self.prefix}{output_id}.{file_ext}"

        # Convert PIL Image to bytes
        buffer = BytesIO()
        image.save(buffer, format=format, optimize=True)
        buffer.seek(0)

        # Determine content type
        content_types = {"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "webp": "image/webp"}
        content_type = content_types.get(file_ext, "image/png")

        # Upload to S3
        self.s3.put_object(
            Bucket=self.bucket,
            Key=s3_key,
            Body=buffer.getvalue(),
            ContentType=content_type,
        )

        # Build download URL
        # CDN: use direct CDN URL (CDN handles public access)
        # No CDN: route through our API (avoids S3 403 on private buckets)
        if self.cdn_url:
            download_url = f"{self.cdn_url}/{s3_key}"
        else:
            download_url = f"{self.base_url}/api/download/{output_id}"

        return StorageResult(
            output_id=output_id,
            download_url=download_url,
            share_url=f"{self.base_url}/api/share/{output_id}",
        )
    
    async def get_image(self, output_id: str) -> Optional[bytes]:
        """Retrieve image from S3."""
        for ext in ["png", "jpg", "jpeg", "webp"]:
            s3_key = f"{self.prefix}{output_id}.{ext}"
            try:
                response = self.s3.get_object(Bucket=self.bucket, Key=s3_key)
                return response["Body"].read()
            except self.s3.exceptions.NoSuchKey:
                continue
            except Exception:
                continue
        return None
    
    async def delete_image(self, output_id: str) -> bool:
        """Delete image from S3."""
        for ext in ["png", "jpg", "jpeg", "webp"]:
            s3_key = f"{self.prefix}{output_id}.{ext}"
            try:
                # Check if object exists first
                self.s3.head_object(Bucket=self.bucket, Key=s3_key)
                self.s3.delete_object(Bucket=self.bucket, Key=s3_key)
                return True
            except Exception:
                continue
        return False


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
        output_id = f"{prefix}{uuid.uuid4().hex[:8]}"
        
        result = await self.provider.save_image(image, output_id)
        
        return result
    
    async def get_output(self, output_id: str) -> Optional[bytes]:
        """Retrieve a previously saved output."""
        return await self.provider.get_image(output_id)
    
    async def delete_output(self, output_id: str) -> bool:
        """Delete a saved output."""
        return await self.provider.delete_image(output_id)

    def get_local_path(self, output_id: str) -> Optional[str]:
        """Get local file path for an output (local provider only)."""
        return self.provider.get_local_path(output_id)


def _create_storage_service() -> StorageService:
    """
    Factory function that creates the StorageService based on config.
    Called once at module load to create the singleton.
    """
    from config import settings

    # Compute absolute output dir relative to project root
    # storage_service.py is at backend/services/, so project root is 3 levels up
    _THIS_DIR = os.path.dirname(os.path.abspath(__file__))
    _PROJECT_ROOT = os.path.dirname(os.path.dirname(_THIS_DIR))
    output_dir = os.path.join(_PROJECT_ROOT, settings.OUTPUTS_DIR)

    if settings.STORAGE_PROVIDER == "s3":
        if not settings.AWS_S3_BUCKET_NAME:
            print("WARNING: STORAGE_PROVIDER=s3 but AWS_S3_BUCKET_NAME not set. Falling back to local.", flush=True)
            provider = LocalStorageProvider(
                output_dir=output_dir,
                base_url=settings.BASE_URL,
            )
        else:
            provider = S3StorageProvider(
                bucket=settings.AWS_S3_BUCKET_NAME,
                region=settings.AWS_REGION,
                access_key_id=settings.AWS_ACCESS_KEY_ID,
                secret_access_key=settings.AWS_SECRET_ACCESS_KEY,
                cdn_url=settings.AWS_S3_CDN_URL,
                base_url=settings.BASE_URL,
            )
    else:
        provider = LocalStorageProvider(
            output_dir=output_dir,
            base_url=settings.BASE_URL,
        )

    return StorageService(provider=provider)


# Singleton instance (auto-configured from .env / config)
storage_service = _create_storage_service()
