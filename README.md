# Photobooth SaaS

A web-based photobooth platform with automatic background removal and accurate template-based sticker placement.

## Architecture

```
photo-booth/
├── frontend/         # Next.js App Router
├── backend/          # FastAPI Python
│   ├── api/          # Route handlers
│   └── services/     # AI + compositing modules
├── templates/        # PNG templates + metadata
└── outputs/          # Generated images (gitignored)
```

## Quick Start

### Backend

```bash
cd backend
venv\Scripts\activate
python -m uvicorn main:app --reload
```

### Frontend

```bash
cd frontend
npm install
npm run dev
```

## Template System

Templates use a metadata-driven placement system with:

- **slots[]**: Multiple photo placement zones per template
- **anchorMode**: Alignment strategy (face_center, eyes, shoulders)
- **Accurate positioning**: No manual drag-resize needed

See `templates/template_schema.json` for the full specification.

## Core Flow

1. User captures photo (webcam) or uploads image
2. Background removal via rembg (U²-Net / IS-Net)
3. Sticker auto-fitted into template slot(s)
4. Final composite PNG generated
5. Download + QR code sharing
