"""
Jobs Service
============
SQLite-backed index of every generated photo.

Schema
------
jobs(
    output_id      TEXT PRIMARY KEY,   -- e.g. "axis-ban-3af6d002"
    guest_name     TEXT NOT NULL DEFAULT '',
    guest_phone    TEXT NOT NULL DEFAULT '',
    template_id    TEXT NOT NULL DEFAULT '',
    template_prefix TEXT NOT NULL DEFAULT '',
    mode           TEXT NOT NULL DEFAULT '',   -- sticker|frame|magazine|word_template
    created_at     REAL NOT NULL,              -- Unix timestamp (UTC)
    downloaded_at  REAL,                       -- NULL until marked; set by ?source=app
    archived       INTEGER NOT NULL DEFAULT 0, -- 0=active, 1=archived
    file_size      INTEGER NOT NULL DEFAULT 0
)

Sections query
--------------
The gallery groups jobs by calendar date in IST (UTC+5:30). The section list
is a cheap GROUP BY; photo rows are fetched lazily per section.

The sections endpoint returns a list like:
  [{"date": "today" | "yesterday" | "YYYY-MM-DD", "count": N, "downloaded": N}]

Archive / download fields replace the old archived.json + lack-of-tracking.
Backfill from S3 / local outputs is run once on startup and adds rows only
for output_ids not already in the DB.

Thread safety: single-worker uvicorn → single event loop → no concurrent writes
to the same row. sqlite3 with WAL mode handles concurrent reads fine.
"""

import logging
import os
import sqlite3
import threading
import time
from contextlib import contextmanager
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DB_PATH = DATA_DIR / "jobs.db"

# IST offset for date-grouping
_IST = timezone(timedelta(hours=5, minutes=30))

_lock = threading.Lock()


def _get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(str(DB_PATH), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextmanager
def _db():
    with _lock:
        conn = _get_conn()
        try:
            yield conn
            conn.commit()
        except Exception:
            conn.rollback()
            raise
        finally:
            conn.close()


def init_db() -> None:
    """Create the jobs table and indexes if they don't exist."""
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    with _db() as conn:
        conn.execute("""
            CREATE TABLE IF NOT EXISTS jobs (
                output_id       TEXT PRIMARY KEY,
                guest_name      TEXT NOT NULL DEFAULT '',
                guest_phone     TEXT NOT NULL DEFAULT '',
                template_id     TEXT NOT NULL DEFAULT '',
                template_prefix TEXT NOT NULL DEFAULT '',
                mode            TEXT NOT NULL DEFAULT '',
                created_at      REAL NOT NULL,
                downloaded_at   REAL,
                archived        INTEGER NOT NULL DEFAULT 0,
                file_size       INTEGER NOT NULL DEFAULT 0
            )
        """)
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_archived ON jobs(archived)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_downloaded ON jobs(downloaded_at)")
        conn.execute("CREATE INDEX IF NOT EXISTS idx_jobs_template ON jobs(template_prefix)")
    logger.info("jobs_service: DB initialised at %s", DB_PATH)


def upsert_job(
    output_id: str,
    *,
    guest_name: str = "",
    guest_phone: str = "",
    template_id: str = "",
    mode: str = "",
    created_at: Optional[float] = None,
    file_size: int = 0,
) -> None:
    """Insert a new job record. Ignores if output_id already exists (idempotent)."""
    prefix = output_id.rsplit("-", 1)[0] if "-" in output_id else output_id
    ts = created_at if created_at is not None else time.time()
    with _db() as conn:
        conn.execute(
            """
            INSERT OR IGNORE INTO jobs
              (output_id, guest_name, guest_phone, template_id, template_prefix, mode, created_at, file_size)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (output_id, guest_name, guest_phone, template_id, prefix, mode, ts, file_size),
        )


def mark_downloaded(output_id: str) -> bool:
    """Set downloaded_at = now. Returns True if a row was updated."""
    with _db() as conn:
        cursor = conn.execute(
            "UPDATE jobs SET downloaded_at = ? WHERE output_id = ?",
            (time.time(), output_id),
        )
        return cursor.rowcount > 0


def unmark_downloaded(output_id: str) -> bool:
    """Clear downloaded_at. Returns True if a row was updated."""
    with _db() as conn:
        cursor = conn.execute(
            "UPDATE jobs SET downloaded_at = NULL WHERE output_id = ?",
            (output_id,),
        )
        return cursor.rowcount > 0


def set_archived(output_id: str, archived: bool) -> bool:
    with _db() as conn:
        cursor = conn.execute(
            "UPDATE jobs SET archived = ? WHERE output_id = ?",
            (1 if archived else 0, output_id),
        )
        return cursor.rowcount > 0


def delete_job(output_id: str) -> bool:
    with _db() as conn:
        cursor = conn.execute("DELETE FROM jobs WHERE output_id = ?", (output_id,))
        return cursor.rowcount > 0


def bulk_mark_downloaded(ids: list[str]) -> int:
    if not ids:
        return 0
    ts = time.time()
    with _db() as conn:
        cursor = conn.executemany(
            "UPDATE jobs SET downloaded_at = ? WHERE output_id = ? AND downloaded_at IS NULL",
            [(ts, oid) for oid in ids],
        )
        return cursor.rowcount


def bulk_unmark_downloaded(ids: list[str]) -> int:
    if not ids:
        return 0
    with _db() as conn:
        cursor = conn.executemany(
            "UPDATE jobs SET downloaded_at = NULL WHERE output_id = ?",
            [(oid,) for oid in ids],
        )
        return cursor.rowcount


def bulk_set_archived(ids: list[str], archived: bool) -> int:
    if not ids:
        return 0
    val = 1 if archived else 0
    with _db() as conn:
        cursor = conn.executemany(
            "UPDATE jobs SET archived = ? WHERE output_id = ?",
            [(val, oid) for oid in ids],
        )
        return cursor.rowcount


def bulk_delete(ids: list[str]) -> int:
    if not ids:
        return 0
    with _db() as conn:
        cursor = conn.executemany(
            "DELETE FROM jobs WHERE output_id = ?",
            [(oid,) for oid in ids],
        )
        return cursor.rowcount


# ── Section / list helpers ────────────────────────────────────────────────────

def _date_label(ts: float) -> str:
    """Convert Unix timestamp → IST date string for grouping."""
    dt = datetime.fromtimestamp(ts, tz=_IST).date()
    today = datetime.now(_IST).date()
    if dt == today:
        return "today"
    if dt == today - timedelta(days=1):
        return "yesterday"
    return dt.strftime("%d/%m/%Y")


def get_sections(status: str = "active") -> dict:
    """
    Returns tab counts + a list of date sections for the gallery.
    status: 'active' | 'downloaded' | 'archived'
    """
    with _lock:
        conn = _get_conn()
        try:
            # Tab totals
            row = conn.execute("""
                SELECT
                    COUNT(*) FILTER (WHERE archived = 0)                     AS total_active,
                    COUNT(*) FILTER (WHERE archived = 0 AND downloaded_at IS NOT NULL) AS total_downloaded,
                    COUNT(*) FILTER (WHERE archived = 1)                     AS total_archived
                FROM jobs
            """).fetchone()

            total_active = row["total_active"]
            total_downloaded = row["total_downloaded"]
            total_archived = row["total_archived"]

            # Date sections for the requested tab
            if status == "active":
                where = "WHERE archived = 0"
            elif status == "downloaded":
                where = "WHERE archived = 0 AND downloaded_at IS NOT NULL"
            else:  # archived
                where = "WHERE archived = 1"

            rows = conn.execute(f"""
                SELECT created_at,
                       downloaded_at IS NOT NULL AS is_downloaded
                FROM jobs {where}
                ORDER BY created_at DESC
            """).fetchall()

            # All rows (no status filter) to compute per-date totals for ZIP picker
            all_rows = conn.execute(
                "SELECT created_at FROM jobs ORDER BY created_at DESC"
            ).fetchall()

        finally:
            conn.close()

    # Group by IST date
    from collections import defaultdict
    section_counts: dict[str, int] = defaultdict(int)
    section_downloaded: dict[str, int] = defaultdict(int)
    section_total: dict[str, int] = defaultdict(int)   # all statuses combined
    section_order: list[str] = []
    seen: set[str] = set()

    for r in rows:
        label = _date_label(r["created_at"])
        if label not in seen:
            section_order.append(label)
            seen.add(label)
        section_counts[label] += 1
        if r["is_downloaded"]:
            section_downloaded[label] += 1

    for r in all_rows:
        section_total[_date_label(r["created_at"])] += 1

    today = datetime.now(_IST).date()
    today_label = "today"
    yesterday_label = "yesterday"

    # Always include today + yesterday even if empty
    for mandatory in (today_label, yesterday_label):
        if mandatory not in seen:
            section_order.insert(0 if mandatory == today_label else 1, mandatory)

    sections = []
    for label in section_order:
        sections.append({
            "date": label,
            "count": section_counts.get(label, 0),
            "downloaded": section_downloaded.get(label, 0),
            "total": section_total.get(label, 0),   # includes archived
        })

    return {
        "total_active": total_active,
        "total_downloaded": total_downloaded,
        "total_archived": total_archived,
        "sections": sections,
    }


def get_jobs_for_section(
    date_label: str,
    status: str = "active",
    limit: int = 75,
    offset: int = 0,
) -> list[dict]:
    """
    Fetch paginated jobs for a single date section.
    date_label: 'today' | 'yesterday' | 'DD/MM/YYYY'
    """
    today = datetime.now(_IST).date()

    if date_label == "today":
        target_date = today
    elif date_label == "yesterday":
        target_date = today - timedelta(days=1)
    else:
        try:
            target_date = datetime.strptime(date_label, "%d/%m/%Y").date()
        except ValueError:
            return []

    # Date range in UTC
    day_start = datetime(
        target_date.year, target_date.month, target_date.day,
        tzinfo=_IST
    ).timestamp()
    day_end = day_start + 86400

    if status == "all":
        status_clause = ""
    elif status == "active":
        status_clause = "AND archived = 0"
    elif status == "pending":
        status_clause = "AND archived = 0 AND downloaded_at IS NULL"
    elif status == "downloaded":
        status_clause = "AND archived = 0 AND downloaded_at IS NOT NULL"
    else:
        status_clause = "AND archived = 1"

    with _lock:
        conn = _get_conn()
        try:
            rows = conn.execute(
                f"""
                SELECT output_id, guest_name, guest_phone, template_id,
                       template_prefix, mode, created_at, downloaded_at,
                       archived, file_size
                FROM jobs
                WHERE created_at >= ? AND created_at < ?
                  {status_clause}
                ORDER BY created_at DESC
                LIMIT ? OFFSET ?
                """,
                (day_start, day_end, limit, offset),
            ).fetchall()
        finally:
            conn.close()

    return [dict(r) for r in rows]


def search_jobs(q: str, status: str = "active", limit: int = 50) -> list[dict]:
    """Full-text search on guest_name and output_id."""
    if not q.strip():
        return []

    if status == "active":
        status_clause = "AND archived = 0"
    elif status == "downloaded":
        status_clause = "AND archived = 0 AND downloaded_at IS NOT NULL"
    else:
        status_clause = "AND archived = 1"

    pattern = f"%{q.strip()}%"
    with _lock:
        conn = _get_conn()
        try:
            rows = conn.execute(
                f"""
                SELECT output_id, guest_name, guest_phone, template_id,
                       template_prefix, mode, created_at, downloaded_at,
                       archived, file_size
                FROM jobs
                WHERE (guest_name LIKE ? OR output_id LIKE ?)
                  {status_clause}
                ORDER BY created_at DESC
                LIMIT ?
                """,
                (pattern, pattern, limit),
            ).fetchall()
        finally:
            conn.close()

    return [dict(r) for r in rows]


def get_all_output_ids() -> set[str]:
    """Return all known output_ids (for backfill de-duplication)."""
    with _lock:
        conn = _get_conn()
        try:
            rows = conn.execute("SELECT output_id FROM jobs").fetchall()
        finally:
            conn.close()
    return {r["output_id"] for r in rows}


def get_job(output_id: str) -> Optional[dict]:
    with _lock:
        conn = _get_conn()
        try:
            row = conn.execute(
                "SELECT * FROM jobs WHERE output_id = ?", (output_id,)
            ).fetchone()
        finally:
            conn.close()
    return dict(row) if row else None


def get_template_prefixes(status: str = "active") -> list[str]:
    if status == "active":
        where = "WHERE archived = 0"
    elif status == "downloaded":
        where = "WHERE archived = 0 AND downloaded_at IS NOT NULL"
    else:
        where = "WHERE archived = 1"
    with _lock:
        conn = _get_conn()
        try:
            rows = conn.execute(
                f"SELECT DISTINCT template_prefix FROM jobs {where} ORDER BY template_prefix"
            ).fetchall()
        finally:
            conn.close()
    return [r["template_prefix"] for r in rows if r["template_prefix"]]


# Singleton-style init is called from main.py lifespan
jobs_service = type("_JobsService", (), {
    "init": staticmethod(init_db),
    "upsert": staticmethod(upsert_job),
    "mark_downloaded": staticmethod(mark_downloaded),
    "unmark_downloaded": staticmethod(unmark_downloaded),
    "set_archived": staticmethod(set_archived),
    "delete": staticmethod(delete_job),
    "bulk_mark_downloaded": staticmethod(bulk_mark_downloaded),
    "bulk_unmark_downloaded": staticmethod(bulk_unmark_downloaded),
    "bulk_set_archived": staticmethod(bulk_set_archived),
    "bulk_delete": staticmethod(bulk_delete),
    "get_sections": staticmethod(get_sections),
    "get_jobs_for_section": staticmethod(get_jobs_for_section),
    "search": staticmethod(search_jobs),
    "get_all_ids": staticmethod(get_all_output_ids),
    "get": staticmethod(get_job),
    "get_template_prefixes": staticmethod(get_template_prefixes),
})()
