# ---- Build Stage ----
FROM python:3.12-slim AS builder

WORKDIR /app

# Install build dependencies for native packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libgl1 \
    libglib2.0-0 \
    libglib2.0-dev \
    && rm -rf /var/lib/apt/lists/*

# Copy and install Python dependencies
COPY requirements.txt .
# Install all deps; mediapipe may fail on ARM64 — that's OK, face service has fallback
RUN pip install --no-cache-dir -r requirements.txt || \
    (echo "WARNING: Some packages failed, retrying without mediapipe..." && \
    grep -v mediapipe requirements.txt > requirements_arm.txt && \
    pip install --no-cache-dir -r requirements_arm.txt)

# ---- Runtime Stage ----
FROM python:3.12-slim

WORKDIR /app

# Install runtime dependencies only
RUN apt-get update && apt-get install -y --no-install-recommends \
    libgl1 \
    libglib2.0-0 \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Copy installed packages from builder
COPY --from=builder /usr/local/lib/python3.12/site-packages /usr/local/lib/python3.12/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin

# Copy application code
COPY . .

# Create outputs and data directories
RUN mkdir -p /app/data

EXPOSE 8000

# Run with uvicorn (single worker — rembg + mediapipe are memory-heavy)
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1"]
