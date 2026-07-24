"""
Photobooth SaaS Backend
=======================
FastAPI application for photo processing, background removal, and template compositing.
"""

from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.generate import router as generate_router
from api.admin import router as admin_router
from api.wtm import router as wtm_router
from api.wtm_admin import router as wtm_admin_router
from api.feature_flags import router as feature_flags_router
from config import settings


async def _backfill_jobs() -> None:
    """
    One-time migration: for every output known to storage but missing from jobs.db,
    insert a minimal row so the gallery doesn't show blank sections for old photos.
    Runs in the background so startup latency is unaffected.
    """
    import asyncio
    await asyncio.sleep(2)  # let server finish starting first

    try:
        from services.jobs_service import jobs_service
        from services.storage_service import storage_service
        from services.archive_service import archive_service
        import time, os

        existing_ids = jobs_service.get_all_ids()
        provider = storage_service.provider

        items: list[dict] = []
        if not hasattr(provider, "s3"):
            # Local storage
            output_dir = getattr(provider, "output_dir", "outputs")
            if os.path.isdir(output_dir):
                for fname in os.listdir(output_dir):
                    fpath = os.path.join(output_dir, fname)
                    if not os.path.isfile(fpath):
                        continue
                    output_id = os.path.splitext(fname)[0]
                    stat = os.stat(fpath)
                    items.append({"output_id": output_id, "created_at": stat.st_mtime, "file_size": stat.st_size})
        else:
            paginator = provider.s3.get_paginator("list_objects_v2")
            for page in paginator.paginate(Bucket=provider.bucket, Prefix=provider.prefix):
                for obj in page.get("Contents", []):
                    key = obj["Key"]
                    filename = key.replace(provider.prefix, "", 1)
                    output_id = os.path.splitext(filename)[0]
                    items.append({
                        "output_id": output_id,
                        "created_at": obj["LastModified"].timestamp(),
                        "file_size": obj["Size"],
                    })

        archived_ids = set(archive_service.list_archived())
        added = 0
        for item in items:
            oid = item["output_id"]
            if oid in existing_ids:
                continue
            prefix = oid.rsplit("-", 1)[0] if "-" in oid else oid
            jobs_service.upsert(
                oid,
                template_id=prefix,
                created_at=item["created_at"],
                file_size=item["file_size"],
            )
            if oid in archived_ids:
                jobs_service.set_archived(oid, True)
            added += 1

        if added:
            print(f"INFO: jobs backfill: added {added} existing outputs to jobs.db", flush=True)
        else:
            print("INFO: jobs backfill: nothing new to add", flush=True)
    except Exception as e:
        print(f"WARNING: jobs backfill failed: {e}", flush=True)


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Pre-warm heavy models on startup so the first request isn't slow."""
    from services.rembg_service import rembg_service
    from services.stats_service import stats_service
    from services.face_service import face_service
    from services.jobs_service import jobs_service
    import asyncio

    jobs_service.init()
    rembg_service.warm_up()
    face_service.warm_up()
    from services.wtm_config import load_all_configs
    from pathlib import Path
    Path(settings.WTM_TEMPLATES_DIR).mkdir(parents=True, exist_ok=True)
    Path(settings.WTM_CACHE_DIR).mkdir(parents=True, exist_ok=True)
    load_all_configs()

    asyncio.create_task(_backfill_jobs())
    yield
    stats_service.flush()


app = FastAPI(
    title="Photobooth SaaS API",
    description="Background removal and template compositing for event photobooths",
    version="0.1.0",
    lifespan=lifespan,
)

# CORS — allow frontend origin (and localhost for dev)
allow_origins = [
    settings.FRONTEND_URL,
    "http://localhost:3000",
    "http://127.0.0.1:3000",
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=allow_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Register API routers
app.include_router(generate_router, prefix="/api", tags=["generate"])
app.include_router(admin_router, prefix="/api/admin", tags=["admin"])
app.include_router(wtm_router, prefix="/api/wtm", tags=["wtm"])
app.include_router(wtm_admin_router, prefix="/api/admin/wtm", tags=["wtm-admin"])
app.include_router(feature_flags_router, prefix="/api", tags=["feature-flags"])


@app.get("/")
async def root():
    """Health check endpoint."""
    return {
        "status": "ok",
        "service": "photobooth-api",
        "version": "0.1.0",
    }


@app.get("/health")
async def health():
    """Detailed health check for deployment monitoring."""
    # Check rembg
    try:
        from services.rembg_service import rembg_service
        rembg_status = "ok" if rembg_service is not None else "unavailable"
    except Exception as e:
        rembg_status = f"error: {str(e)}"

    # Check storage
    try:
        from services.storage_service import storage_service
        provider_type = type(storage_service.provider).__name__
        storage_status = f"ok ({provider_type})"
    except Exception as e:
        storage_status = f"error: {str(e)}"

    return {
        "status": "healthy",
        "storage_provider": settings.STORAGE_PROVIDER,
        "services": {
            "rembg": rembg_status,
            "storage": storage_status,
        },
    }
