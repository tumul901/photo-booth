# Social Wall — Project Overview

A real-time social wall application where users capture photos via a camera page (with client-side background removal), which are then displayed on a live social wall. An admin panel allows moderation of uploaded images.

---

## Tech Stack

| Layer | Technology |
|---|---|
| **Backend** | Node.js, Express |
| **Real-time** | Socket.IO |
| **Database** | SQLite via `sql.js` (file-based) |
| **Auth** | JWT (`jsonwebtoken`) |
| **Image Processing** | `sharp` (resize, composite, WebP conversion), `multer` (upload handling) |
| **Frontend** | Vanilla HTML/CSS/JS, Socket.IO client |
| **Background Removal** | Client-side WASM (requires COOP/COEP headers) |

---

## Folder Structure

```
social wall/
├── backend/                         # Node.js + Express server
│   ├── .env                         # Environment variables (JWT_SECRET, ADMIN_USERNAME, ADMIN_PASSWORD, PORT)
│   ├── package.json                 # Dependencies & scripts (start, dev)
│   ├── server.js                    # Entry point — Express app, Socket.IO setup, COOP/COEP headers, route mounting
│   │
│   ├── db/
│   │   ├── database.js              # sql.js database init, CRUD helpers for images table
│   │   └── social_wall.db           # SQLite database file (auto-created)
│   │
│   ├── middleware/
│   │   └── auth.js                  # JWT authentication middleware (authenticateToken)
│   │
│   └── routes/
│       ├── auth.js                  # POST /api/auth/login, GET /api/auth/verify
│       ├── upload.js                # POST /api/upload — image upload, Sharp processing, Socket.IO broadcast
│       └── admin.js                 # CRUD for images (list, edit text, archive, restore, delete) — JWT protected
│
├── frontend/                        # Static files served by Express
│   ├── index.html                   # Camera/capture page (main public page at /)
│   ├── wall.html                    # Social wall display page (real-time via Socket.IO)
│   ├── login.html                   # Admin login page
│   ├── admin.html                   # Admin panel (image moderation)
│   │
│   ├── css/
│   │   ├── camera.css               # Styles for the camera/capture page
│   │   ├── wall.css                 # Styles for the social wall display
│   │   ├── login.css                # Styles for the admin login page
│   │   └── admin.css                # Styles for the admin panel
│   │
│   └── js/
│       ├── camera.js                # Camera capture logic, client-side background removal, image upload
│       ├── wall.js                  # Social wall rendering, Socket.IO listeners (new-image, update-image, remove-image)
│       ├── login.js                 # Admin login form, JWT token storage
│       └── admin.js                 # Admin panel logic — image list, edit, archive, restore, delete
│
└── uploads/                         # Uploaded & processed images (WebP format)
    └── wall_*.webp                  # Processed images with colored backgrounds
```

---

## Database Schema

**Table: `images`**

| Column | Type | Description |
|---|---|---|
| `id` | INTEGER (PK, auto) | Unique image ID |
| `image_path` | TEXT | Path to the stored image (e.g. `/uploads/wall_xxx.webp`) |
| `text` | TEXT | User-provided caption (max 20 chars) |
| `bg_color` | TEXT | Random Google-palette hex color (`#EA4335`, `#4285F4`, `#34A853`, `#FBBC05`, `#A142F4`) |
| `status` | TEXT | `active` or `archived` |
| `created_at` | DATETIME | Auto-set on creation |
| `updated_at` | DATETIME | Auto-set on update |

---

## API Endpoints

### Public (no auth)

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/auth/login` | Admin login — returns JWT |
| `GET` | `/api/auth/verify` | Verify JWT validity |
| `POST` | `/api/upload` | Upload image (multipart form: `image` file + `text`) |
| `GET` | `/api/images` | Fetch all active images for the wall |

### Protected (JWT required)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/admin/images` | List all images (optional `?status=active` filter) |
| `PUT` | `/api/admin/images/:id` | Edit image caption text |
| `PATCH` | `/api/admin/images/:id/archive` | Soft-delete (archive) an image |
| `PATCH` | `/api/admin/images/:id/restore` | Restore an archived image |
| `DELETE` | `/api/admin/images/:id` | Permanently delete image + file |

---

## Socket.IO Events

| Event | Direction | Payload | Trigger |
|---|---|---|---|
| `new-image` | Server → Client | Full image object | New upload or restored image |
| `update-image` | Server → Client | Updated image object | Caption text edited |
| `remove-image` | Server → Client | `{ id }` | Image archived or deleted |

---

## Upload Processing Pipeline

1. Client captures photo & removes background (WASM, client-side)
2. Transparent PNG uploaded to `POST /api/upload`
3. Server resizes to 400×400 with `sharp`
4. Random Google-palette color background generated
5. Person composited onto colored background
6. Saved as `.webp` (quality 85) to `uploads/`
7. Database record created → Socket.IO `new-image` broadcast → wall updates in real-time
