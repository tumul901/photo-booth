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

import { useRef, useCallback, useState, useEffect, useMemo } from 'react';
import styles from './WebcamCapture.module.css';
import type { ProcessingMode } from '@/types/processingMode';

// Frame-overlay capture guide. The template's PNG is a pre-keyed matte — opaque
// except for a transparent window — laid over the live video at full opacity, so
// the feed only shows through the window and everything outside is covered. The
// backend composites the identical file onto the artwork, so what the guest lines
// up in the viewfinder is exactly what they get.

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
  isProcessing?: boolean;
  processingMode?: ProcessingMode;
}

export default function WebcamCapture({
  selectedTemplate,
  onCapture,
  onError,
  mirrored = true,
  isProcessing = false,
  processingMode,
}: WebcamCaptureProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [isReady, setIsReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16');
  // Default to the back/rear camera ('environment'). Passed as an "ideal"
  // constraint (not exact), so single-camera devices fall back to their only
  // camera instead of erroring. The 🔄 button still flips to the front camera.
  const [facingMode, setFacingMode] = useState<'user' | 'environment'>('environment');
  
  const [showGuide, setShowGuide] = useState(false);
  // Set from the template config. When a template pins a capture aspect we hide
  // the ratio picker: a mismatched ratio would misalign the guide against the
  // output canvas, which defeats the whole point of framing at capture time.
  const [lockedAspect, setLockedAspect] = useState<AspectRatio | null>(null);
  const [frameOverlay, setFrameOverlay] = useState(false);
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

  // Fetch template visual guide settings (regular frame/sticker templates only)
  useEffect(() => {
    if (!selectedTemplate || processingMode === 'word_template') {
      setShowGuide(false);
      setFrameOverlay(false);
      setLockedAspect(null);
      return;
    }

    fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`)
      .then(res => res.json())
      .then(data => {
        if (data && typeof data.showVisualGuide === 'boolean') {
          setShowGuide(data.showVisualGuide);
        }

        // Frame-matte templates overlay their PNG at full opacity instead of the
        // faint alignment guide, so the preview shows the real window.
        setFrameOverlay(!!data?.frameOverlay);

        const pinned = data?.captureAspect;
        if (pinned && ASPECT_RATIOS.some(a => a.id === pinned)) {
          setLockedAspect(pinned as AspectRatio);
          setAspectRatio(pinned as AspectRatio);
        } else {
          setLockedAspect(null);
        }
      })
      .catch(err => console.error("Template config error:", err));
  }, [selectedTemplate, processingMode]);

  // Main Camera Initialization Logic
  useEffect(() => {
    let mounted = true;
    
    async function initCamera() {
      try {
        // Ask for the largest sensor feed the device will give.
        //
        // Capture resolution is the ceiling on cutout quality: the frame is
        // cropped to the template aspect before background removal, so a 720p
        // stream cropped to 4:5 leaves only 576x720 for the matting model to
        // work with, and the artwork is then an upscale of that. Asking for 4K
        // as the *ideal* makes the browser pick the highest mode available and
        // fall back gracefully on cameras that top out lower.
        const constraints: MediaStreamConstraints = {
          video: {
            facingMode,
            width: { ideal: 3840 },
            height: { ideal: 2160 },
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
          // Log what the camera actually granted — the requested ideal is only a
          // hint, and the granted size caps how much detail the cutout can have.
          const granted = track.getSettings();
          console.info(
            `[camera] granted ${granted.width}x${granted.height} @${granted.frameRate ?? '?'}fps ` +
            `(requested ideal 3840x2160)`
          );
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

  // Stop camera when processing starts — frees GPU/battery while loader spins
  useEffect(() => {
    if (isProcessing && stream) {
      stream.getTracks().forEach(t => t.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
    }
  }, [isProcessing, stream]);

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

    onCapture(canvas.toDataURL('image/jpeg', 0.92));
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
      {!lockedAspect && (
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
      )}

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

        {/* Frame matte — the same PNG the artwork is composited with. Opaque
            outside the window, so the feed is visibly clipped to it live. */}
        {selectedTemplate && frameOverlay && isReady && !error && (
          <div className={styles.templateGuide}>
            <img
              src={`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/image`}
              alt=""
              aria-hidden="true"
              className={styles.frameOverlayImage}
            />
          </div>
        )}

        {/* Template alignment guide (faint, PNG-based templates) */}
        {selectedTemplate && showGuide && !frameOverlay && isReady && (
          <div className={styles.templateGuide}>
            <img 
              src={
                processingMode === 'word_template'
                  ? `${API_BASE_URL}/api/admin/wtm/templates/${selectedTemplate}/image`
                  : `${API_BASE_URL}/api/admin/templates/${selectedTemplate}/image`
              }
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
