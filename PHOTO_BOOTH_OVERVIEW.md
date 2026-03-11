# Photo Booth SaaS — Project Overview

A high-performance, event-ready photo booth application featuring AI-powered background removal and dynamic template compositing. Designed for real-time engagement and seamless social sharing.

---

## 🚀 Key Features

### 1. AI Background Removal
- **Real-time Processing:** Instant background removal using advanced AI models (`u2net` / `rembg`).
- **Edge Softening:** High-quality portrait extraction for professional-looking results.
- **Client-Side Preview:** Interactive manual positioning allows users to perfect their shot before final rendering.

### 2. Dynamic Template Compositing
- **Overlay & Underlay Support:** Smart layering allows users to appear "behind" decorative elements (stickers) or "inside" frames.
- **Multi-Mode Support:** Swap between "Frame Mode" (full-frame branding) and "Sticker Mode" (decorative icons and overlays).
- **Proportional Scaling:** Automatic scaling and centering to ensure the user always fits the shot.

### 3. High-Speed Image Delivery
- **Optimized Storage:** Dual-layer storage strategy combining local disk caching for instant delivery and S3/Cloud storage for permanent archiving.
- **QR Code Sharing:** Instant result retrieval via dynamic QR codes generated for every capture.
- **Preview Thumbnails:** Fast gallery loading using optimized thumbnails.

---

## 🛠️ Technical Stack

- **Frontend:** [Next.js](https://nextjs.org/) (React) + TypeScript + CSS Modules.
- **Backend:** [FastAPI](https://fastapi.tiangolo.com/) (Python) + [Uvicorn](https://www.uvicorn.org/).
- **Image Processing:** [Pillow (PIL)](https://python-pillow.org/) + [Sharp](https://sharp.pixelplumbing.com/) (for some frontend-adjacent tasks).
- **AI/ML:** [rembg](https://github.com/danielgatis/rembg) (U2Net) for portrait extraction.
- **Deployment:** Docker + Docker Compose + Nginx.

---

## 🔄 Basic User Workflow

The application follows a streamlined 4-step wizard to ensure a smooth guest experience:

### Step 1: Mode Selection
Users choose between different experience styles (e.g., **Frame Mode** for branded borders or **Sticker Mode** for interactive props).

### Step 2: Template Selection
Guests browse and select from a variety of event-themed templates and overlays.

### Step 3: Photo Capture & Edit
- **Capture:** A live countdown triggers the camera.
- **Manual Positioning (Optional):** If enabled for the template, guests can pinch, zoom, or drag their extracted portrait to fit the design perfectly.

### Step 4: Result & Sharing
- **Instant Preview:** The final composited image is displayed immediately.
- **Sharing:** Guests scan a QR code to download their photo to their mobile device or share it on social media.
- **Start Over:** The booth automatically resets for the next guest after a timeout or manual click.

---

## 📂 Folder Structure

- `/frontend`: Next.js web application (User interface & wizard logic).
- `/backend`: FastAPI service (AI processing & image compositing).
- `/templates`: Configuration and assets for frames, stickers, and themes.
- `/nginx`: Configuration for reverse proxy and static asset serving.
