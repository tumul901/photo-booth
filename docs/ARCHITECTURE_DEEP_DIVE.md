# Photo Booth SaaS — Architecture & Workflow Deep Dive

This document provides an **extremely detailed** breakdown of the Photo Booth SaaS platform, focusing on its architecture, technology stack, directory structure, and the complex workflows that power its AI-driven compositing engine.

---

## 1. 🚀 Technology Stack in Detail

### 1.1 Backend: The Python Compositing Engine
The backend is completely decoupled from the frontend, operating as a high-performance RESTful API.

* **Framework & Core Server:**
    * **FastAPI (`fastapi>=0.109.0`)**: Handles high-concurrency API routing. Its asynchronous nature is vital since image processing can involve blocking I/O and heavy CPU computation.
    * **uvicorn (`uvicorn[standard]>=0.27.0`)**: The ASGI server running FastAPI.
    * **Pydantic (`pydantic>=2.5.0`)**: Strictly validates all incoming form data and JSON payloads (e.g., `TemplateMetadata`, `SlotMetadata`).
* **AI & Computer Vision Layer:**
    * **rembg (`rembg[cpu]>=2.0.50`)**: Provides state-of-the-art background removal using U²-Net and silueta models. Optimized to run on CPU by removing backgrounds fast before compositing.
    * **MediaPipe (`mediapipe>=0.10.9`)**: Used specifically for **Face Landmark Detection**. It detects the eyes, nose, and face bounding box to calculate exactly where to anchor a "sticker" cutout on a template body.
    * **NumPy (`numpy>=1.26.0`)**: Used for fast coordinate array manipulations during face landmark bounding box calculations and image cropping.
* **Image Processing & Rasterization:**
    * **Pillow (`pillow>=10.2.0`)**: The workhorse for all PNG scaling, alpha-compositing, image cropping, and format conversions.
    * **CairoSVG (`cairosvg>=2.7.0`) & cairocffi**: Crucial for the WTM (Word Template Mode). It dynamically converts vector `.svg` text assets into transparent `.png` rasters at high resolutions before pasting them onto the base template.
* **Infrastructure & Storage:**
    * **boto3 (`boto3>=1.34.0`)**: Manages the integration with AWS S3. Outputs are saved to a local folder instantly to speed up the frontend UI response (QR code generation), while `boto3` uploads the final files to an S3 bucket (`photo-booth-cp`) via a deferred background task.

### 1.2 Frontend: The Next.js Interactive Wizard
The frontend provides a stateful, interactive kiosk experience.

* **Framework**: **Next.js App Router** with **React 18+**, written in strict **TypeScript**.
* **State Management**: Uses custom `useSessionState` hooks mapped to browser `sessionStorage`. This means if the user accidentally refreshes the browser on an iPad/Kiosk, they don't lose their photo or their step in the 5-part wizard.
* **Hardware Interfacing**: Uses HTML5 `navigator.mediaDevices.getUserMedia` for 1080p/4K webcam capture inside a `<video>` element, snapping frames onto an offscreen `<canvas>` to generate the `base64` image data.
* **Styling**: Modular `CSS Modules` (`.module.css`) to enforce strict stylistic encapsulation, preventing global style conflicts between the Admin Panel and the Guest Wizard.

---

## 2. 📂 Deep Dive File-Folder Structure

### `backend/` (The FastAPI Application)
```text
backend/
├── main.py                     # App lifespan events (pre-warming rembg/mediapipe), router mounting, CORS setup.
├── config.py                   # Environment variable loading via Pydantic BaseSettings.
├── api/                        # Route Controllers
│   ├── generate.py             # POST /api/generate & /api/extract. Directs standard sticker & manual positioning flows.
│   ├── wtm.py                  # POST /api/wtm/generate & GET /api/wtm/composed-image. Exclusively handles Word Template Mode.
│   ├── admin.py                # CRUD endpoints for managing standard templates and reviewing generated social wall outputs.
│   └── wtm_admin.py            # Endpoints dedicated to the highly complex WTM template schema/bundle editor.
├── services/                   # Business Logic & Processors
│   ├── compose.py              # THE CORE ENGINE. Contains `ComposeService.compose_final()` and the mathematical `SmartFit` algorithm to map facial landmarks to template slots.
│   ├── face_service.py         # Wrapper around MediaPipe. Returns `FaceLandmarks` (center_x, center_y, confidence).
│   ├── rembg_service.py        # Wrapper around `rembg` session. Runs `remove(img)`.
│   ├── wtm_composer.py         # Takes a base image and a list of SVG words, scales words to fit exact slot bounding boxes, and returns a cached composited background.
│   ├── wtm_config.py           # Loads WTM `config.json` files and parses slots, bundles, and metadata.
│   ├── storage_service.py      # Dual-write storage behavior. Writes local `.jpg`/`.webp` first, then returns an `upload_fn` async task to send to S3 without blocking the HTTP request.
│   └── stats_service.py        # Analytics tracker for template usage.
└── schemas/                    # Pydantic Types
    ├── wtm_schemas.py          # Strict definitions for `ComposeRequest`, `WordItem`, `BundleItem`.
    └── ...
```

### `frontend/` (The Next.js Application)
```text
frontend/
├── app/
│   ├── page.tsx                # The Master Controller. A 5-step wizard managing Mode -> Template -> Words(WTM) -> Capture/Edit -> Result.
│   └── page.module.css         # Layout styling for the fullscreen kiosk format.
├── components/
│   ├── screens/                # The 5 primary Wizard screens
│   │   ├── StartScreen.tsx     # Step 1: Select "Sticker" or "WTM".
│   │   ├── TemplateScreen.tsx  # Step 2: Select the specific template layout.
│   │   ├── WordSelectionStep.tsx # Step 3 (WTM-only): Interactive grid to pick words/bundles. Hits `/api/wtm/compose`.
│   │   ├── CaptureScreen.tsx   # Step 4: Live Webcam preview, 3-second countdown, and base64 snapshot logic.
│   │   ├── PreviewEditScreen.tsx # Step 4.5: If manual layout enabled. Loads transparent cutout over background, enables drag/pinch-to-zoom using complex pointer events.
│   │   └── ResultScreen.tsx    # Step 5: Shows the final composite + QR Code for mobile download.
│   ├── WTMAdmin.tsx            # Massive admin editor for placing bounding-box slots for WTM text over a background image.
│   └── WTMSlotEditor.tsx       # Draggable, resizable bounding boxes overlay logic for admin panel.
└── types/
    └── wtm.ts                  # Shared interfaces keeping frontend sync'd with Python schemas.
```

### `templates/` (Data Store)
```text
templates/
├── <template_id>.png           # Standard sticker mode transparent foreground/backgrounds.
├── <template_id>.json          # Metadata defining `slots` (x, y, w, h) and `anchorMode` (e.g., 'eyes').
├── wtm/
│   └── <wtm_id>/               # WTM specific folders
│       ├── base.png            # The blank background lacking words.
│       ├── config.json         # Defines an array of word-slots AND exactly ONE `photo_slot`.
│       └── words/              # Directory of raw `.svg` files mapped to user options.
└── wtm_cache/                  # Auto-generated by backend. Holds `<hash>.png` files representing the base.png + user's chosen words composited together.
```

---

## 3. ⚙️ Micro-level Event Workflows (Extreme Detail)

### Workflow 3.1: Automatic AI Sticker Mode
**Trigger:** User selects a standard template, takes a photo. Admin config `allowManualPositioning` is FALSE.

1.  **Frontend Capture:** `WebcamCapture.tsx` grabs a base64 JPEG from the `<video>` element on shutter click. Passes binary buffer via `FormData` to backend `/api/generate`.
2.  **Rembg Pipeline:** `generate.py` parses photos. Passes buffer to `rembg_service.py`. The U²-Net model isolates the person shape.
3.  **Alpha Cropping:** `compose_service.crop_to_alpha_bbox` finds the non-transparent pixels and crops away dead space.
4.  **Face Landmark Mapping:** `face_service.py` scans the cropped person. It identifies Y-axis line of the eyes.
5.  **SmartFit Composition:**
    * `compose.py` calculates the `res_multiplier` if the template implies high-res scaling.
    * It looks at the `.json` `slot` coordinates for the template. Let's say `x:100, y:100, width:500, height:600`.
    * It calculates a `target_fill_ratio` to ensure the face fits optimally inside the `600px` height.
    * Since `anchorMode` = `eyes` or `face_center`, math computes the exact `(x, y)` coordinate on the underlying canvas so that the detected face (e.g., coordinate `(150, 40)`) aligns with the template slot's `anchor_target_y`.
    * `canvas.paste(sticker, (calculated_x, calculated_y), mask=sticker)` applies the person over the background.
6.  **Dual Storage Output:** Image compiled to `RGB` → saved instantly to `outputs/xxxx.jpg`. Backend returns HTTP 200 with `{ "download_url": "/api/download/xxxx" }`. Background `asyncio.create_task` uploads to S3 silently. Frontend `ResultScreen` uses the URL to generate a QR code.

### Workflow 3.2: WTM (Word Template Mode)
**Trigger:** A user navigates to Step 3 (`WordSelectionStep.tsx`) and picks 4 motivational words. Note: *This mode combines raster generation and AI logic.*

1.  **Frontend Compose Request:** User confirms picked words ("Champion", "Limitless"). Frontend sends `POST /api/wtm/compose` with `selected_words: ["champion", "limitless"]`.
2.  **Vector-to-Raster Composition (`wtm_composer.py`):**
    * Backend calculates an SHA-256 hash string of the template ID + sorted word array. Checks `wtm_cache/`.
    * If MISS: It opens `base.png`. Iterates through the selected words, looking up the corresponding SVG (e.g., `champion.svg`).
    * Reads the destination slot bounding box for that word from `config.json`. Generates a Cairo scaling matrix to fit the SVG perfectly inside the box without stretching ratio out.
    * Renders SVG to PNG byte buffer, drops into Pillow mask, pastes onto canvas.
    * Caches `wtm_cache/<hash>.png` and returns it.
3.  **Frontend Generation Request:** User takes a photo. Frontend triggers `/api/wtm/generate` and passes the photo AND the `composedTemplatePath` (`wtm_cache/<hash>.png`).
4.  **The Sticker Overlay Phase:**
    * Background processes the photo (rembg + face detect) like Workflow 3.1.
    * **CRITICAL INVERSION:** Instead of generating based on a static template, `compose_final()` treats the dynamically created `wtm_cache/<hash>.png` as `composite_mode="background"`.
    * The photo is scaled and placed. **Crucially:** Because WTM words surround the subject, the sticker is passed through a strict `.crop()` bounding logic so the user's shoulders/arms cut off cleanly inside the `photo_slot` boundary rather than accidentally overwriting the custom rasterized SVG words.

### Workflow 3.3: Interactive Manual Positioning (Drag/Zoom)
**Trigger:** Admin `allowManualPositioning` is TRUE, or user is in WTM Mode.

1.  **Direct Background Extraction:** Before the user even sees an editor, `PreviewEditScreen.tsx` hits `/api/extract` on mount. This skips the compositing logic entirely and just returns the transparent `rembg` PNG of the user to the frontend.
2.  **HTML/CSS Editor Canvas:**
    * Frontend displays two layers: Base Layer `<img>` (from `/api/admin/templates/{id}/image` or `/api/wtm/composed-image`) and an absolute Overlay `<img>` (the extracted cutout).
    * **Pointer Events:** The overlay utilizes strict `onPointerDown`/`onPointerMove`. Single finger touch records `setPos({x, y})`. Two-finger touch calculates Cartesian hypotenuse between points to generate a `setScale()` math multiplier (pinch-to-zoom).
3.  **Calculated Payload (`handleDone`):**
    * When user hits "Generate", frontend captures its own visual boundaries.
    * Because CSS `object-fit: contain` means visual pixels do NOT match DOM `.clientWidth`, math translates `div` scale into true pixel boundaries.
    * Payload `{ x, y, scale, editorWidth, stickerWidth }` maps coordinates accurately even between Retina displays vs standard 1080p monitors.
4.  **Bypass Auto-Placement on Backend:**
    * Request hits standard POST endpoint, but with `processing_mode = "pre_extracted"` and `photo_position` JSON.
    * Because `pre_extracted` is flagged, `generate.py` totally skips running `rembg` again (saving 0.8s).
    * `compose.py` intercepts `photo_position`. It calculates a `scale factor (sf)` dividing `template.width` by `editorWidth`. It multiplies the user's `X` / `Y` / `Scale` shifts by `sf`, applies an Image.LANCZOS resize to the cutout, calculates offset from canvas center, and invokes `canvas.paste()` exactly where the fingers left it. No face-landmarks needed!
