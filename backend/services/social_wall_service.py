"""
Social Wall Integration Service
================================
Handles sending generated photos to the Social Wall app.
Features:
- Auto-detects the active event from the Social Wall API
- Retry logic with exponential backoff
- Fire-and-forget (never blocks photo booth operations)
- Proper logging
"""

import asyncio
import json
import logging
from urllib.request import urlopen, Request
from urllib.error import URLError
from typing import Optional

from config import settings

logger = logging.getLogger("social_wall")
logger.setLevel(logging.INFO)

# Add console handler if none exists
if not logger.handlers:
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(
        "%(asctime)s [SocialWall] %(levelname)s: %(message)s",
        datefmt="%H:%M:%S",
    ))
    logger.addHandler(handler)


class SocialWallService:
    """Service to send photos to the Social Wall."""

    def __init__(self):
        self.base_url: Optional[str] = settings.SOCIAL_WALL_URL
        self.event_id: Optional[str] = settings.SOCIAL_WALL_EVENT_ID
        self._active_event_cache: Optional[dict] = None
        self._cache_timestamp: float = 0
        self._cache_ttl: float = 60  # Re-check active event every 60s
        self._enabled = bool(self.base_url)

        if self._enabled:
            logger.info(f"✅ Social Wall integration ENABLED → {self.base_url}")
            if self.event_id:
                logger.info(f"   Event ID (from .env): {self.event_id}")
            else:
                logger.info("   Event ID: auto-detect from active event")
        else:
            logger.info("ℹ️  Social Wall integration disabled (SOCIAL_WALL_URL not set)")

    async def _get_active_event_id(self) -> Optional[str]:
        """
        Get the active event ID. Priority:
        1. SOCIAL_WALL_EVENT_ID from .env (if set)
        2. Auto-detect from /api/wall/active endpoint
        """
        # If hardcoded in .env, always use that
        if self.event_id:
            return self.event_id

        # Check cache
        import time
        now = time.time()
        if self._active_event_cache and (now - self._cache_timestamp) < self._cache_ttl:
            return self._active_event_cache.get("id")

        # Fetch from Social Wall API
        try:
            loop = asyncio.get_event_loop()
            response = await loop.run_in_executor(None, lambda: urlopen(
                f"{self.base_url}/api/wall/active", timeout=5
            ))
            data = json.loads(response.read().decode("utf-8"))
            self._active_event_cache = data
            self._cache_timestamp = now
            event_id = data.get("id")
            logger.info(f"🎯 Auto-detected active event: {data.get('name', '?')} ({event_id})")
            return event_id
        except Exception as e:
            logger.warning(f"Could not auto-detect active event: {e}")
            return None

    async def send_photo(self, image_url: str, max_retries: int = 3) -> bool:
        """
        Send a photo URL to the Social Wall with retry logic.
        Returns True if successful, False otherwise.
        """
        if not self._enabled:
            return False

        event_id = await self._get_active_event_id()
        if not event_id:
            logger.warning("⚠️ No active event found — photo NOT sent to Social Wall")
            return False

        payload = json.dumps({
            "image_url": image_url,
            "event_id": event_id,
            "source_name": "Photo Booth",
        }).encode("utf-8")

        for attempt in range(1, max_retries + 1):
            try:
                req = Request(
                    f"{self.base_url}/api/submit",
                    data=payload,
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )

                loop = asyncio.get_event_loop()
                response = await loop.run_in_executor(
                    None, lambda: urlopen(req, timeout=5)
                )
                result = json.loads(response.read().decode("utf-8"))

                status = result.get("status", "unknown")
                logger.info(
                    f"✅ Photo sent to Social Wall! "
                    f"Status: {status} | Event: {event_id[:8]}... | "
                    f"Attempt: {attempt}/{max_retries}"
                )
                return True

            except Exception as e:
                wait_time = 2 ** attempt  # Exponential backoff: 2s, 4s, 8s
                if attempt < max_retries:
                    logger.warning(
                        f"⚠️ Social Wall submit failed (attempt {attempt}/{max_retries}): {e}. "
                        f"Retrying in {wait_time}s..."
                    )
                    await asyncio.sleep(wait_time)
                else:
                    logger.error(
                        f"❌ Social Wall submit FAILED after {max_retries} attempts: {e}"
                    )

        return False

    def fire_and_forget(self, image_url: str):
        """
        Schedule sending a photo as a background task.
        Never blocks the photo booth response.
        """
        if not self._enabled:
            return

        async def _task():
            success = await self.send_photo(image_url)
            if not success:
                logger.error("Photo was NOT delivered to Social Wall")

        try:
            loop = asyncio.get_event_loop()
            loop.create_task(_task())
        except RuntimeError:
            logger.warning("Could not schedule Social Wall task (no event loop)")


# Singleton instance
social_wall_service = SocialWallService()
