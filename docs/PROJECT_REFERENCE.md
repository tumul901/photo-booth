# Photo Booth SaaS — Project Reference

Comprehensive documentation of the Photo Booth platform architecture, technology stack, and core operational workflows.

---

## 🚀 Tech Stack

### Backend (Python/FastAPI)
The backend is a high-performance AI-driven processing engine responsible for image segmentation, face detection, and complex compositing.

- **Framework**: `FastAPI` (modern, fast, asynchronous web framework)
- **Server**: `uvicorn` (ASGI server implementation)
- **Image Processing**:
  - `Pillow (PIL)`: Core image manipulation and compositing.
  - `rembg`: Background removal using AI models (U²-Net / silueta).
  - `CairoSVG` & `cairocffi`: Rasterizing SVG word assets for WTM templates.
- **AI & Computer Vision**:
  - `MediaPipe`: Accurate face landmark detection for smart sticker anchoring.
  - `NumPy`: High-speed coordinate transformations and matrix math.
- **Infrastructure**:
  - `boto3`: AWS S3 integration for persistent cloud storage.
  - `Pydantic`: Robust data validation and settings management.

### Frontend (Next.js/React)
The frontend is a step-wise wizard designed for high-resolution photo capture and interactive editing.

- **Framework**: `Next.js` (App Router)
- **Language**: `TypeScript` (for type-safe component development)
- **State Management**: `React Hooks` (persisted via `sessionStorage` for refresh-proof wizardry)
- **Styling**: `Vanilla CSS` with `CSS Modules` for scoped, premium designs.
- **Camera Handling**: Native `MediaDevices API` with low-latency canvas-based previews.

---

## 📂 Project Structure

```text
photo-booth/
├── frontend/                # Next.js App Router (React)
│   ├── app/                 # Main entrance /page.tsx (Wizard)
│   ├── components/          # Reusable UI & Screen Components
│   │   ├── screens/         # Step-specific screens (Start, Template, Capture, Edit, Result)
│   │   └── WordSelection/   # WTM specific selection logic
│   ├── hooks/               # Custom React hooks (session storage, camera)
│   └── types/               # TypeScript interface definitions (wtm.ts, etc.)
│
├── backend/                 # FastAPI Application (Python)
│   ├── main.py              # Application entry point & route mounting
│   ├── api/                 # Endpoint handlers
│   │   ├── generate.py      # Standard sticker/frame generation
│   │   └── wtm.py           # Word Template Mode (WTM) endpoints
│   ├── services/            # Core business logic (Single Responsibility)
│   │   ├── compose.py       # The SmartFit™ compositing engine
│   │   ├── face_service.py  # MediaPipe face detection integration
│   │   ├── rembg_service.py # AI background removal
│   │   ├── wtm_composer.py  # Word-on-template SVG rasterization
│   │   └── storage_service.py # Local + S3 storage abstraction
│   ├── schemas/             # Pydantic models for API request/response validation
│   └── utils/               # Common helpers (caching, logging)
│
├── templates/               # Asset store (PNGs + JSON configs)
│   ├── wtm/                 # WTM base templates & word SVGs
│   └── wtm_cache/           # Pre-composed word templates (transient)
│
├── docs/                    # Implementation plans & Architecture docs
└── outputs/                 # Locally saved generated images (ignored by git)
```

---

## 🔄 Core Workflows

### 1. Standard Sticker Mode
The "automatic" mode where AI handles everything.
1. **Capture**: Frontend captures high-res webcam photo.
2. **Transfer**: Multipart form upload to `/api/generate`.
3. **Segmentation**: Backend uses `rembg` to remove background.
4. **Anchoring**: `MediaPipe` finds eyes/nose; `SmartFit` scales the sticker to match the `photo_slot`.
5. **Composite**: Sticker is alpha-composited over the template PNG.
6. **Delivery**: Image saved to local/S3; QR code URL returned to guest.

### 2. WTM (Word Template Mode)
A custom flow allowing visitors to "compose" their own layout.
1. **Selection**: Guest picks words (e.g., "Champion", "Limitless") from the frontend WordSelectionStep.
2. **Composition**: `/api/wtm/compose` is called. Backend rasterizes SVGs on the fly, pastes them into word-slots, and caches a "composed template" PNG.
3. **Generation**: `/api/wtm/generate` is called with the guest's photo. The sticker is placed into the `photo_slot` defined in the WTM config.

### 3. Interactive Positioning (Editing)
For templates requiring pixel-perfect user control.
1. **Capture**: Guest captures photo.
2. **Extraction**: Frontend hits `/api/extract` to get a transparent cutout immediately.
3. **Editing**: `PreviewEditScreen` opens. User drags, pinches, and resizes the cutout over the template preview.
4. **Final Stage**: `executeGeneration` passes the exact `{ x, y, scale }` to the backend.
5. **No-Detection Paste**: Backend skips face detection and uses the coordinates provided by the user via the `user_position` branch.

---

## 🛠 Features & Capabilities
- **SmartFit™ Engine**: Automatically scales photos based on face height to ensure guests look consistent across different captures.
- **Slot Clipping**: Ensures guest photos never overflow template boundaries (critical for WTM word layouts).
- **Hybrid Storage**: Instant local delivery for speed, deferred S3 upload for durability.
- **WTM Admin**: Configurable bundles and slots for dynamic template generation.
