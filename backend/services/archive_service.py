"""
Archive Service
===============
Soft-hides output images from the main gallery without deleting them from S3.
Persists the archived id set to backend/data/archived.json using atomic writes.

Single-worker uvicorn guarantees no concurrent writes — no lock needed.
If the project ever moves to multi-worker, wrap _save_atomic with filelock.
"""

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"


class ArchiveService:
    def __init__(self, data_dir: Path = DATA_DIR):
        self.path = data_dir / "archived.json"
        self._cache: set[str] | None = None

    def _load(self) -> set[str]:
        if self._cache is not None:
            return self._cache
        try:
            with open(self.path, "r", encoding="utf-8") as f:
                raw = json.load(f)
            self._cache = set(raw.get("archived", []))
        except FileNotFoundError:
            self._cache = set()
        except Exception as e:
            logger.error(f"archive_service: failed to load {self.path}: {e}; using empty set")
            self._cache = set()
        return self._cache

    def _save_atomic(self, archived: set[str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = Path(str(self.path) + ".tmp")
        payload = {
            "archived": sorted(archived),
            "updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2)
        os.replace(tmp, self.path)
        self._cache = archived

    def is_archived(self, output_id: str) -> bool:
        return output_id in self._load()

    def add(self, output_id: str) -> None:
        ids = set(self._load())
        ids.add(output_id)
        self._save_atomic(ids)

    def remove(self, output_id: str) -> None:
        ids = set(self._load())
        ids.discard(output_id)
        self._save_atomic(ids)

    def add_many(self, ids: list[str]) -> int:
        current = set(self._load())
        before = len(current)
        current.update(ids)
        self._save_atomic(current)
        return len(current) - before

    def remove_many(self, ids: list[str]) -> int:
        current = set(self._load())
        before = len(current)
        current.difference_update(ids)
        self._save_atomic(current)
        return before - len(current)

    def list_archived(self) -> list[str]:
        return sorted(self._load())


archive_service = ArchiveService()
