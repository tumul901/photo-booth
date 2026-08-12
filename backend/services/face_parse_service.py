"""
Face Parsing Service
====================
Semantic decomposition of a portrait into hair / skin / clothing regions, plus
dense facial landmarks. This is the foundation the watercolor renderer draws
from, and the reason it can succeed where the earlier line-art attempt failed.

That attempt derived outlines from image gradients (XDoG). Gradients follow
TEXTURE — stubble, fabric weave, sensor noise — not FORM, so a jawline against a
similarly-lit neck produced no line at all while a patterned shirt produced
dozens. The result was a silhouette with an empty face.

Parsing inverts that. Region boundaries are semantic: the hair/skin border is
exactly as findable on a dark-haired subject with deep skin tone as on a blond
one, because the network is answering "is this hair?" rather than "is there a
step in luminance here?". Outlines drawn from those boundaries are closed,
follow anatomy, and stay consistent across the couple of hundred guests an event
puts through the booth — which is the property that actually matters.

Two MediaPipe Tasks models, ~20MB together, cached in backend/models:

  ImageSegmenter (selfie_multiclass_256x256)
      6 classes: background, hair, body-skin, face-skin, clothes, others.
      Runs at 256x256 internally, so raw output is coarse — see _refine().

  FaceLandmarker (face_landmarker.task)
      478 points including the 10 iris points, which is what lets the renderer
      place a drawn iris at its true position and radius instead of guessing.

Both degrade to None rather than raising. A booth mid-event must produce
something for every guest, so callers fall back to a featureless render rather
than showing an error.
"""

import os
import time
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np
from PIL import Image

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False
    print("INFO: MediaPipe not available — watercolor mode will be unavailable.", flush=True)


# ── Segmenter class indices (selfie_multiclass_256x256) ──────────────────────
BACKGROUND, HAIR, BODY_SKIN, FACE_SKIN, CLOTHES, OTHERS = range(6)
CLASS_NAMES = ("background", "hair", "body_skin", "face_skin", "clothes", "others")

MODEL_URLS = {
    "selfie_multiclass_256x256.tflite":
        "https://storage.googleapis.com/mediapipe-models/image_segmenter/"
        "selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite",
    "face_landmarker.task":
        "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
        "face_landmarker/float16/latest/face_landmarker.task",
}

# ── Landmark index groups (MediaPipe FaceMesh canonical topology) ─────────────
# Hard-coded rather than read from mp.solutions.face_mesh.FACEMESH_* so a
# MediaPipe upgrade that reorganises those constants can't silently change which
# points the renderer draws. These indices are part of the model's published
# topology and are stable across versions.
FACE_OVAL = [
    10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
    378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
    162, 21, 54, 103, 67, 109,
]
# Eye rings, ordered so they form a closed polygon when drawn in sequence
RIGHT_EYE = [33, 246, 161, 160, 159, 158, 157, 173, 133, 155, 154, 153, 145, 144, 163, 7]
LEFT_EYE = [362, 398, 384, 385, 386, 387, 388, 466, 263, 249, 390, 373, 374, 380, 381, 382]
RIGHT_BROW = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46]
LEFT_BROW = [300, 293, 334, 296, 336, 285, 295, 282, 283, 276]
LIPS_OUTER = [
    61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17,
    84, 181, 91, 146,
]
LIPS_INNER = [
    78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14,
    87, 178, 88, 95,
]
NOSE_BRIDGE = [168, 6, 197, 195, 5, 4]
NOSE_BASE = [64, 99, 240, 2, 460, 328, 294]
RIGHT_IRIS = [469, 470, 471, 472]
LEFT_IRIS = [474, 475, 476, 477]
RIGHT_IRIS_CENTER = 468
LEFT_IRIS_CENTER = 473


@dataclass
class FaceParse:
    """
    A parsed portrait: one label map, per-class boolean masks, and landmarks.

    `labels` is the argmax category map at full image resolution. `landmarks` is
    (478, 2) in absolute pixels, or None when no face was found — the renderer
    still has the region masks in that case and degrades to a featureless
    portrait rather than failing.
    """
    labels: np.ndarray                     # (H, W) uint8, values 0-5
    landmarks: Optional[np.ndarray]        # (478, 2) float32 in pixels, or None
    width: int
    height: int
    parse_ms: float
    landmark_ms: float

    def mask(self, *classes: int) -> np.ndarray:
        """Boolean mask for one or more classes, unioned."""
        out = np.zeros(self.labels.shape, bool)
        for c in classes:
            out |= self.labels == c
        return out

    @property
    def person(self) -> np.ndarray:
        """Everything that isn't background."""
        return self.labels != BACKGROUND

    @property
    def skin(self) -> np.ndarray:
        return self.mask(FACE_SKIN, BODY_SKIN)

    def points(self, indices: list[int]) -> Optional[np.ndarray]:
        """Landmark subset as an int32 (N, 2) array ready for cv2 polygon ops."""
        if self.landmarks is None:
            return None
        return np.round(self.landmarks[indices]).astype(np.int32)

    def coverage(self) -> dict[str, float]:
        """Percentage of the canvas each class occupies — used by tests and logs."""
        total = self.labels.size
        return {name: float((self.labels == i).sum()) / total * 100
                for i, name in enumerate(CLASS_NAMES)}


class FaceParseService:
    """Lazy-loading singleton. Mirrors FaceService's download-on-first-use pattern."""

    def __init__(self):
        self.segmenter = None
        self.landmarker = None
        self._init_failed = False

    # ── Model files ──────────────────────────────────────────────────────────

    def _models_dir(self) -> str:
        d = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
        os.makedirs(d, exist_ok=True)
        return d

    def _ensure_model(self, filename: str) -> Optional[str]:
        path = os.path.join(self._models_dir(), filename)
        if os.path.exists(path) and os.path.getsize(path) > 1024:
            return path
        try:
            import urllib.request
            print(f"INFO: downloading {filename} ...", flush=True)
            # Download to a temp name and rename, so an interrupted download can
            # never leave a truncated file that looks valid on the next start.
            tmp = path + ".part"
            urllib.request.urlretrieve(MODEL_URLS[filename], tmp)
            os.replace(tmp, path)
            print(f"INFO: {filename} ready ({os.path.getsize(path) // 1024}KB)", flush=True)
            return path
        except Exception as e:
            print(f"WARNING: could not fetch {filename}: {e}", flush=True)
            return None

    def _init(self) -> bool:
        """Create both tasks. Idempotent; returns False if unavailable."""
        if self.segmenter is not None and self.landmarker is not None:
            return True
        if self._init_failed or not MEDIAPIPE_AVAILABLE:
            return False

        try:
            seg_path = self._ensure_model("selfie_multiclass_256x256.tflite")
            lm_path = self._ensure_model("face_landmarker.task")
            if not seg_path or not lm_path:
                self._init_failed = True
                return False

            self.segmenter = mp_vision.ImageSegmenter.create_from_options(
                mp_vision.ImageSegmenterOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=seg_path),
                    running_mode=mp_vision.RunningMode.IMAGE,
                    # Confidence masks, not the hard category mask: a 256x256
                    # argmax upscaled to 1080 gives blocky stair-stepped borders,
                    # and outlines traced from those look like pixel art. Soft
                    # per-class confidences survive edge-aware refinement, so we
                    # take the argmax only AFTER refining. See _refine().
                    output_category_mask=False,
                    output_confidence_masks=True,
                )
            )
            self.landmarker = mp_vision.FaceLandmarker.create_from_options(
                mp_vision.FaceLandmarkerOptions(
                    base_options=mp_python.BaseOptions(model_asset_path=lm_path),
                    running_mode=mp_vision.RunningMode.IMAGE,
                    num_faces=1,
                    min_face_detection_confidence=0.4,
                    min_face_presence_confidence=0.4,
                    output_face_blendshapes=False,
                    output_facial_transformation_matrixes=False,
                )
            )
            print("INFO: face parsing ready (segmenter + landmarker)", flush=True)
            return True
        except Exception as e:
            print(f"WARNING: face parsing init failed: {e}", flush=True)
            self._init_failed = True
            return False

    def warm_up(self) -> None:
        """Load models and run one dummy frame so the first guest isn't the cold start."""
        if not self._init():
            print("INFO: face parsing unavailable — watercolor mode will degrade", flush=True)
            return
        try:
            self.parse(Image.new("RGB", (256, 256), (128, 128, 128)))
            print("INFO: face parsing warm-up complete", flush=True)
        except Exception as e:
            print(f"WARNING: face parsing warm-up failed: {e}", flush=True)

    @property
    def available(self) -> bool:
        return self._init()

    # ── Mask refinement ──────────────────────────────────────────────────────

    @staticmethod
    def _refine(confidences: list[np.ndarray], guide_rgb: np.ndarray,
                radius: int, eps: float) -> np.ndarray:
        """
        Edge-align the coarse 256x256 confidences to the real image, then argmax.

        Guided filtering pulls each class boundary onto the nearest strong edge in
        the source photo. Without it the hair/skin border sits wherever a 256px
        grid happened to land — several pixels off at output resolution, and
        visibly wrong along a jaw or hairline once an outline is drawn on it.

        Refining BEFORE the argmax matters: filtering a hard 0/1 mask just blurs
        the staircase, whereas filtering the soft confidences lets the boundary
        genuinely move to where the edge is.
        """
        guide = np.ascontiguousarray(guide_rgb)
        refined = []
        for conf in confidences:
            c = np.ascontiguousarray(conf.astype(np.float32))
            try:
                c = cv2.ximgproc.guidedFilter(guide, c, radius, eps)
            except Exception:
                # ximgproc missing (bare opencv-python rather than -contrib):
                # a bilateral pass is a weaker but real substitute.
                c = cv2.bilateralFilter(c, 9, 0.1, radius)
            refined.append(c)
        return np.argmax(np.stack(refined, axis=0), axis=0).astype(np.uint8)

    def _retry_via_detector(self, rgb_full: np.ndarray, W: int, H: int) -> Optional[np.ndarray]:
        """
        Second attempt at landmarks, cropped around whatever the booth's own
        face detector found.

        FaceLandmarker bundles a stricter detector than the BlazeFace one the
        booth already runs, and the two genuinely disagree: there are real
        photographs where BlazeFace locks on cleanly and FaceLandmarker returns
        nothing at ANY resolution — a wide frame with a busy background is the
        usual case. Since a miss silently costs every drawn feature, and the
        booth is already holding a working detection, it is worth handing the
        landmarker a tight crop and asking again.

        Returns landmarks in FULL-image pixels, or None.
        """
        try:
            from services.face_service import face_service
            from PIL import Image as _Image

            found = face_service.detect_landmarks(_Image.fromarray(rgb_full))
            if not found:
                return None

            fh = max(int(getattr(found, "face_height", 0)), 32)
            # Generous margin: the landmarker wants the whole head plus context,
            # and a crop tight to the bbox loses the chin and hairline it keys on.
            half = fh * 1.6
            cx, cy = float(found.center_x), float(found.center_y)
            x0 = int(max(0, cx - half))
            y0 = int(max(0, cy - half))
            x1 = int(min(W, cx + half))
            y1 = int(min(H, cy + half))
            if x1 - x0 < 48 or y1 - y0 < 48:
                return None

            crop = np.ascontiguousarray(rgb_full[y0:y1, x0:x1])
            res = self.landmarker.detect(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=crop)
            )
            if not res.face_landmarks:
                return None

            cw, ch = x1 - x0, y1 - y0
            pts = res.face_landmarks[0]
            print(f"INFO: landmarks recovered via detector crop ({cw}x{ch})", flush=True)
            return np.array([[p.x * cw + x0, p.y * ch + y0] for p in pts], np.float32)
        except Exception as e:
            print(f"DEBUG: landmark retry failed: {e}", flush=True)
            return None

    # ── Public API ───────────────────────────────────────────────────────────

    def parse(
        self,
        image: Image.Image,
        *,
        max_side: int = 768,
        landmark_max_side: int = 1440,
        refine_radius: int = 8,
        refine_eps: float = 1e-4,
    ) -> Optional[FaceParse]:
        """
        Parse a portrait into semantic regions and landmarks.

        Args:
            image:         RGB or RGBA. RGBA is flattened onto neutral grey — the
                           segmenter is trained on photographs, and compositing a
                           cutout onto black would put a hard false edge right
                           where the real silhouette is, dragging the parse
                           boundaries onto it.
            max_side:      Work resolution cap. The model is 256x256 regardless,
                           so a larger guide buys edge accuracy, not detail, and
                           costs guided-filter time. Masks are returned at the
                           input's full resolution either way.
            refine_radius: Guided-filter window, in working-resolution pixels.
            refine_eps:    Guided-filter regularisation. Smaller = follows edges
                           harder, at the cost of picking up texture.

        Returns:
            FaceParse, or None if models are unavailable or segmentation failed.
        """
        if not self._init():
            return None

        try:
            W, H = image.width, image.height
            if image.mode == "RGBA":
                flat = Image.new("RGB", (W, H), (128, 128, 128))
                flat.paste(image, mask=image.getchannel("A"))
                rgb_full = np.array(flat)
            else:
                rgb_full = np.array(image.convert("RGB"))

            scale = min(1.0, max_side / max(W, H))
            if scale < 1.0:
                work = cv2.resize(rgb_full, (max(int(W * scale), 1), max(int(H * scale), 1)),
                                  interpolation=cv2.INTER_AREA)
            else:
                work = rgb_full

            # ── Segmentation ──
            t0 = time.perf_counter()
            mp_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                              data=np.ascontiguousarray(work))
            seg = self.segmenter.segment(mp_img)
            confs = [m.numpy_view() for m in seg.confidence_masks]
            labels = self._refine(confs, work, refine_radius, refine_eps)
            if labels.shape != (H, W):
                labels = cv2.resize(labels, (W, H), interpolation=cv2.INTER_NEAREST)
            parse_ms = (time.perf_counter() - t0) * 1000

            # ── Landmarks ──
            # Deliberately NOT reusing the segmenter's work image. Segmentation
            # is capped low because its model is 256x256 regardless, but the
            # landmarker has to FIND the face first, and on a wide canvas a
            # correctly-framed guest can be a small fraction of the frame — at
            # 768px their face lands near the detector's floor and comes back
            # empty, silently dropping every drawn feature. Landmarking costs
            # tens of milliseconds, so it gets its own, larger budget.
            t1 = time.perf_counter()
            landmarks = None
            try:
                lm_scale = min(1.0, landmark_max_side / max(W, H))
                if abs(lm_scale - scale) < 1e-6:
                    lm_img = mp_img
                else:
                    lm_arr = (rgb_full if lm_scale >= 1.0 else cv2.resize(
                        rgb_full,
                        (max(int(W * lm_scale), 1), max(int(H * lm_scale), 1)),
                        interpolation=cv2.INTER_AREA,
                    ))
                    lm_img = mp.Image(image_format=mp.ImageFormat.SRGB,
                                      data=np.ascontiguousarray(lm_arr))

                lm_result = self.landmarker.detect(lm_img)
                if lm_result.face_landmarks:
                    pts = lm_result.face_landmarks[0]
                    # Normalised coords are fractions of whatever was fed in, so
                    # scaling by the ORIGINAL size maps them to full resolution
                    # regardless of which working image produced them.
                    landmarks = np.array([[p.x * W, p.y * H] for p in pts], np.float32)
                else:
                    landmarks = self._retry_via_detector(rgb_full, W, H)
            except Exception as e:
                print(f"DEBUG: landmark detection failed: {e}", flush=True)
            landmark_ms = (time.perf_counter() - t1) * 1000

            return FaceParse(
                labels=labels,
                landmarks=landmarks,
                width=W,
                height=H,
                parse_ms=parse_ms,
                landmark_ms=landmark_ms,
            )
        except Exception as e:
            print(f"WARNING: face parse failed: {e}", flush=True)
            return None


face_parse_service = FaceParseService()
