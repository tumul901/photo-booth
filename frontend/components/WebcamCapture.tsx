'use client';

/**
 * WebcamCapture Component
 * =======================
 * Handles webcam video stream and photo capture for the booth.
 * 
 * Rebuilt Architecture:
 * - Wrapper sized to selected output ratio.
 * - Video uses object-fit: cover to fill wrapper (True WYSIWYG).
 * - Canvas capture implements matching crop logic at native resolution.
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import styles from './WebcamCapture.module.css';

// Aspect ratio options
type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5' | '3:4';

const ASPECT_RATIOS: { id: AspectRatio; label: string; icon: string }[] = [
  { id: '9:16', label: 'Phone Port.', icon: '📱' },
  { id: '4:5', label: 'Instagram', icon: '📸' },
  { id: '1:1', label: 'Square', icon: '⬜' },
  { id: '3:4', label: 'Classic', icon: '🖼️' },
  { id: '16:9', label: 'Phone Land.', icon: '🤳' },
];

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface WebcamCaptureProps {
  selectedTemplate?: string;
  onCapture: (imageData: string) => void;
  onError?: (error: string) => void;
  mirrored?: boolean;
}

export default function WebcamCapture({
  selectedTemplate,
  onCapture,
  onError,
  mirrored = true,
}: WebcamCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('user');
  
  const [showGuide, setShowGuide] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [zoomRange, setZoomRange] = useState({ min: 1, max: 1 });
  const [hasZoom, setHasZoom] = useState(false);

  // Helper to toggle between front/back cameras
  const toggleCamera = useCallback(() => {
    setFacingMode(prev => prev === 'user' ? 'environment' : 'user');
  }, []);

  // Get numeric aspect ratio value
  const getAspectRatioValue = useCallback((ratio: AspectRatio): number => {
    const [w, h] = ratio.split(':').map(Number);
    return w / h;
  }, []);

  // Fetch template visual guide settings
  useEffect(() => {
    if (!selectedTemplate) {
      setShowGuide(false);
      return;
    }
    
    fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`)
      .then(res => res.json())
      .then(data => {
        if (data && typeof data.showVisualGuide === 'boolean') {
          setShowGuide(data.showVisualGuide);
        }
      })
      .catch(err => console.error("Template config error:", err));
  }, [selectedTemplate]);

  // Main Camera Initialization Logic
  useEffect(() => {
    let mounted = true;
    
    async function initCamera() {
      try {
        // Request widest possible sensor feed - no explicit orientation-based width/height swaps here.
        // Let the system provide the best high-res feed it can.
        const constraints: MediaStreamConstraints = { 
          video: { 
            facingMode,
            width: { ideal: 1920 },
            height: { ideal: 1920 }
          },
          audio: false,
        };

        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }

        const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
        
        if (!mounted) {
          mediaStream.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          setStream(mediaStream);
          setIsReady(true);
          setError(null);
          
          // Detect Hardware Zoom
          const track = mediaStream.getVideoTracks()[0];
          const capabilities = track.getCapabilities() as any;
          if (capabilities.zoom) {
            setHasZoom(true);
            setZoomRange({ min: capabilities.zoom.min, max: capabilities.zoom.max });
            // Always default to 1x to ensure widest natural FOV initially
            setZoom(Math.max(capabilities.zoom.min, 1.0));
          } else {
            setHasZoom(false);
          }

          videoRef.current.onloadedmetadata = () => {
            if (videoRef.current) {
              console.log(`Webcam native resolution: ${videoRef.current.videoWidth}x${videoRef.current.videoHeight}`);
            }
          };
        }
      } catch (err) {
        if (!mounted) return;
        const msg = err instanceof Error ? err.message : 'Camera access error';
        setError(msg);
        onError?.(msg);
      }
    }
    
    initCamera();
    return () => { mounted = false; };
  }, [facingMode]); // Only re-init when switching cameras, not on aspect ratio changes

  // Synchronize zoom state to camera hardware
  useEffect(() => {
    if (!stream || !hasZoom) return;
    const track = stream.getVideoTracks()[0];
    track.applyConstraints({ advanced: [{ zoom: zoom } as any] })
      .catch(err => console.error("Zoom apply error:", err));
  }, [zoom, stream, hasZoom]);

  // Final capture cleanup
  useEffect(() => {
    return () => stream?.getTracks().forEach(t => t.stop());
  }, [stream]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const vW = video.videoWidth;
    const vH = video.videoHeight;
    
    // We must match the CSS "object-fit: cover" math perfectly
    const targetRatio = getAspectRatioValue(aspectRatio);
    const videoRatio = vW / vH;
    
    let sW, sH, sX, sY;
    
    // Logic for "Cover": Fill the target container, cropping excess from center
    if (targetRatio > videoRatio) {
      // Container is wider than video feed - crop top/bottom
      sW = vW;
      sH = vW / targetRatio;
      sX = 0;
      sY = (vH - sH) / 2;
    } else {
      // Container is taller than video feed - crop sides
      sH = vH;
      sW = vH * targetRatio;
      sX = (vW - sW) / 2;
      sY = 0;
    }
    
    canvas.width = sW;
    canvas.height = sH;
    
    // Handle Mirroring
    const isMirrored = mirrored && facingMode === 'user';
    if (isMirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, sX, sY, sW, sH, 0, 0, sW, sH);

    onCapture(canvas.toDataURL('image/png'));
  }, [mirrored, onCapture, aspectRatio, facingMode, getAspectRatioValue]);

  const startCountdown = useCallback(() => setCountdown(3), []);

  useEffect(() => {
    if (countdown === null) return;
    if (countdown > 0) {
      const t = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(t);
    } else {
      capturePhoto();
      setCountdown(null);
    }
  }, [countdown, capturePhoto]);

  return (
    <div className={styles.webcamContainer}>
      <div className={styles.aspectSelector}>
        {ASPECT_RATIOS.map((ar) => (
          <button
            key={ar.id}
            className={`${styles.aspectButton} ${aspectRatio === ar.id ? styles.aspectActive : ''}`}
            onClick={() => setAspectRatio(ar.id)}
          >
            <span className={styles.aspectIcon}>{ar.icon}</span>
            <span className={styles.aspectLabel}>{ar.label}</span>
          </button>
        ))}
      </div>

      <div 
        className={styles.videoWrapper}
        style={{ aspectRatio: `${getAspectRatioValue(aspectRatio)}` }}
      >
        {isReady && !error && (
          <button className={styles.flipButton} onClick={toggleCamera}>🔄</button>
        )}

        {error && (
          <div className={styles.placeholder}>
            <span className={styles.cameraIcon}>🚫</span>
            <p className={styles.hint}>{error}</p>
          </div>
        )}
        
        {!isReady && !error && (
          <div className={styles.placeholder}>
            <span className={styles.cameraIcon}>📷</span>
            <p>Initializing...</p>
          </div>
        )}
        
        {countdown !== null && countdown > 0 && (
          <div className={styles.countdownOverlay}>
            <span className={styles.countdownNumber} key={countdown}>{countdown}</span>
          </div>
        )}
        
        {/* The Frame is the container itself */}
        {isReady && !error && (
          <div className={styles.frameBorder} />
        )}

        {/* Template alignment guide */}
        {selectedTemplate && showGuide && isReady && (
          <div className={styles.templateGuide}>
            <img 
              src={`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/image`} 
              alt="Guide" 
              className={`${styles.guideImage} ${mirrored && facingMode === 'user' ? styles.mirrored : ''}`} 
            />
          </div>
        )}

        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`${styles.video} ${mirrored && facingMode === 'user' ? styles.mirrored : ''}`}
          style={{ display: isReady && !error ? 'block' : 'none' }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>

      <button className={styles.captureButton} onClick={startCountdown} disabled={!isReady || countdown !== null}>
        <span className={styles.captureIcon}>📸</span>
        {countdown !== null ? 'Ready...' : 'Capture Photo'}
      </button>

      {isReady && hasZoom && zoomRange.max > zoomRange.min && (
        <div className={styles.zoomControl}>
          <span className={styles.zoomLabel}>Zoom</span>
          <input
            type="range"
            min={zoomRange.min}
            max={zoomRange.max}
            step="0.1"
            value={zoom}
            onChange={(e) => setZoom(parseFloat(e.target.value))}
            className={styles.zoomSlider}
          />
          <span className={styles.zoomValue}>{zoom.toFixed(1)}x</span>
        </div>
      )}
    </div>
  );
}
