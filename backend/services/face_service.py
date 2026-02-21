"""
Face Detection Service - Production Grade
==========================================
Dual-detector approach for robust face detection in event environments:
1. Primary: MediaPipe BlazeFace (fast, good for frontal)
2. Fallback: OpenCV DNN (robust for varied angles/lighting)

Returns face landmarks for smart sticker positioning.
"""

import numpy as np
from PIL import Image
from dataclasses import dataclass
from typing import Optional, Tuple
import os
import cv2

# MediaPipe Tasks API imports
try:
    import mediapipe as mp
    from mediapipe.tasks import python
    from mediapipe.tasks.python import vision
    MEDIAPIPE_AVAILABLE = True
except ImportError:
    MEDIAPIPE_AVAILABLE = False
    print("INFO: MediaPipe not available. Using OpenCV only.", flush=True)


@dataclass
class FaceLandmarks:
    """Key face landmarks in absolute image pixels."""
    center_x: int
    center_y: int
    eye_y: int      # Average Y of left and right eye (estimated)
    face_height: int
    confidence: float


class FaceService:
    """
    Robust face detection service with multiple backends.
    
    In event environments, we need reliable detection even with:
    - Variable lighting (indoor booths, outdoor events)
    - Different distances (close selfies, group shots)
    - Various angles (not perfectly frontal)
    """
    
    def __init__(self):
        """Initialize both detection backends."""
        self.mp_detector = None
        self.cv_net = None
        
        # Initialize MediaPipe (Primary)
        self._init_mediapipe()
        
        # Initialize OpenCV DNN (Fallback)
        self._init_opencv()
        
        # Log status
        if self.mp_detector:
            print("✅ Primary detector: MediaPipe BlazeFace", flush=True)
        if self.cv_net is not None:
            print("✅ Fallback detector: OpenCV DNN (Caffe)", flush=True)
        
        if not self.mp_detector and self.cv_net is None:
            print("⚠️ WARNING: No face detectors available!", flush=True)
    
    def _init_mediapipe(self):
        """Initialize MediaPipe face detector."""
        if not MEDIAPIPE_AVAILABLE:
            return
            
        try:
            model_path = self._get_mp_model_path()
            
            if not os.path.exists(model_path):
                self._download_mp_model()
            
            if os.path.exists(model_path):
                base_options = python.BaseOptions(model_asset_path=model_path)
                options = vision.FaceDetectorOptions(
                    base_options=base_options,
                    min_detection_confidence=0.5
                )
                self.mp_detector = vision.FaceDetector.create_from_options(options)
        except Exception as e:
            print(f"MediaPipe init failed: {e}", flush=True)
    
    def _init_opencv(self):
        """Initialize OpenCV DNN face detector."""
        try:
            models_dir = self._get_models_dir()
            prototxt = os.path.join(models_dir, "deploy.prototxt")
            caffemodel = os.path.join(models_dir, "res10_300x300_ssd_iter_140000.caffemodel")
            
            if not os.path.exists(prototxt) or not os.path.exists(caffemodel):
                self._download_opencv_model()
            
            if os.path.exists(prototxt) and os.path.exists(caffemodel):
                self.cv_net = cv2.dnn.readNetFromCaffe(prototxt, caffemodel)
        except Exception as e:
            print(f"OpenCV DNN init failed: {e}", flush=True)
    
    def _get_models_dir(self) -> str:
        """Get models directory path."""
        models_dir = os.path.join(os.path.dirname(os.path.dirname(__file__)), "models")
        os.makedirs(models_dir, exist_ok=True)
        return models_dir
    
    def _get_mp_model_path(self) -> str:
        """Get MediaPipe model path."""
        return os.path.join(self._get_models_dir(), "blaze_face_short_range.tflite")
    
    def _download_mp_model(self):
        """Download MediaPipe BlazeFace model."""
        import urllib.request
        model_url = "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite"
        try:
            print("Downloading MediaPipe face model...", flush=True)
            urllib.request.urlretrieve(model_url, self._get_mp_model_path())
            print("✅ MediaPipe model downloaded", flush=True)
        except Exception as e:
            print(f"Download failed: {e}", flush=True)
    
    def _download_opencv_model(self):
        """Download OpenCV DNN face detection model (Caffe)."""
        import urllib.request
        models_dir = self._get_models_dir()
        
        # OpenCV face detection model URLs
        prototxt_url = "https://raw.githubusercontent.com/opencv/opencv/master/samples/dnn/face_detector/deploy.prototxt"
        caffemodel_url = "https://raw.githubusercontent.com/opencv/opencv_3rdparty/dnn_samples_face_detector_20170830/res10_300x300_ssd_iter_140000.caffemodel"
        
        try:
            print("Downloading OpenCV face model...", flush=True)
            urllib.request.urlretrieve(prototxt_url, os.path.join(models_dir, "deploy.prototxt"))
            urllib.request.urlretrieve(caffemodel_url, os.path.join(models_dir, "res10_300x300_ssd_iter_140000.caffemodel"))
            print("✅ OpenCV model downloaded", flush=True)
        except Exception as e:
            print(f"Download failed: {e}", flush=True)

    def detect_landmarks(self, image: Image.Image) -> Optional[FaceLandmarks]:
        """
        Detect face in a PIL Image using best available detector.
        
        Strategy:
        1. Try MediaPipe first (faster, better for frontal faces)
        2. Fall back to OpenCV DNN if MediaPipe fails
        
        Returns landmarks for the most confident face detected.
        """
        # Try MediaPipe first
        if self.mp_detector:
            result = self._detect_mediapipe(image)
            if result:
                print(f"DEBUG: Face detected via MediaPipe", flush=True)
                return result
        
        # Fallback to OpenCV
        if self.cv_net is not None:
            result = self._detect_opencv(image)
            if result:
                print(f"DEBUG: Face detected via OpenCV", flush=True)
                return result
        
        print("DEBUG: No face detected by any detector", flush=True)
        return None
    
    def _detect_mediapipe(self, image: Image.Image) -> Optional[FaceLandmarks]:
        """Detect face using MediaPipe."""
        try:
            if image.mode != 'RGB':
                image_rgb = image.convert('RGB')
            else:
                image_rgb = image
                
            img_array = np.array(image_rgb)
            height, width = img_array.shape[:2]
            
            mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=img_array)
            detection_result = self.mp_detector.detect(mp_image)
            
            if not detection_result.detections:
                return None
            
            detection = detection_result.detections[0]
            bbox = detection.bounding_box
            
            center_x = bbox.origin_x + bbox.width // 2
            center_y = bbox.origin_y + bbox.height // 2
            
            # Get eye position from keypoints
            eye_y = center_y - bbox.height // 4  # Estimate: eyes are ~25% from top of face
            if detection.keypoints and len(detection.keypoints) >= 2:
                right_eye = detection.keypoints[0]
                left_eye = detection.keypoints[1]
                eye_y = int((right_eye.y + left_eye.y) / 2 * height)
            
            confidence = detection.categories[0].score if detection.categories else 0.5
            
            return FaceLandmarks(
                center_x=int(center_x),
                center_y=int(center_y),
                eye_y=int(eye_y),
                face_height=int(bbox.height),
                confidence=float(confidence)
            )
        except Exception as e:
            print(f"MediaPipe detection error: {e}", flush=True)
            return None
    
    def _detect_opencv(self, image: Image.Image) -> Optional[FaceLandmarks]:
        """Detect face using OpenCV DNN."""
        try:
            if image.mode != 'RGB':
                image_rgb = image.convert('RGB')
            else:
                image_rgb = image
                
            img_array = np.array(image_rgb)
            height, width = img_array.shape[:2]
            
            # Prepare image for DNN
            blob = cv2.dnn.blobFromImage(
                cv2.resize(img_array, (300, 300)), 
                1.0, 
                (300, 300), 
                (104.0, 177.0, 123.0)
            )
            
            self.cv_net.setInput(blob)
            detections = self.cv_net.forward()
            
            # Find best detection
            best_detection = None
            best_confidence = 0.5  # Minimum threshold
            
            for i in range(detections.shape[2]):
                confidence = detections[0, 0, i, 2]
                if confidence > best_confidence:
                    best_confidence = confidence
                    best_detection = detections[0, 0, i, 3:7]
            
            if best_detection is None:
                return None
            
            # Scale bounding box to original image size
            box = best_detection * np.array([width, height, width, height])
            x1, y1, x2, y2 = box.astype(int)
            
            face_width = x2 - x1
            face_height = y2 - y1
            center_x = x1 + face_width // 2
            center_y = y1 + face_height // 2
            
            # Estimate eye position (eyes are roughly 25-30% from top of face)
            eye_y = y1 + int(face_height * 0.35)
            
            return FaceLandmarks(
                center_x=center_x,
                center_y=center_y,
                eye_y=eye_y,
                face_height=face_height,
                confidence=float(best_confidence)
            )
        except Exception as e:
            print(f"OpenCV detection error: {e}", flush=True)
            return None
    
    # Property for backward compatibility
    @property
    def detector(self):
        """Check if any detector is available."""
        return self.mp_detector or self.cv_net


# Singleton instance
face_service = FaceService()
