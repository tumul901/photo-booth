"""
Photobooth SaaS Backend
=======================
FastAPI application for photo processing, background removal, and template compositing.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.generate import router as generate_router
from api.admin import router as admin_router
from config import settings

app = FastAPI(
    title="Photobooth SaaS API",
    description="Background removal and template compositing for event photobooths",
    version="0.1.0",
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
