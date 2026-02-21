"""
Photobooth SaaS Backend
=======================
FastAPI application for photo processing, background removal, and template compositing.
"""

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from api.generate import router as generate_router
from api.admin import router as admin_router

app = FastAPI(
    title="Photobooth SaaS API",
    description="Background removal and template compositing for event photobooths",
    version="0.1.0",
)

# CORS configuration for frontend access
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
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
    return {
        "status": "healthy",
        "services": {
            "rembg": "stub",  # TODO: Add actual model load check
            "storage": "stub",  # TODO: Add storage connectivity check
        },
    }
