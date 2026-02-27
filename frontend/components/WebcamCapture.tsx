'use client';

/**
 * WebcamCapture Component
 * =======================
 * Handles webcam video stream and photo capture for the booth.
 * 
 * Features:
 * - Aspect ratio selection (Portrait, Landscape, Square)
 * - Countdown timer before capture
 * - Mirror mode toggle
 * - High resolution capture
 */

import { useRef, useCallback, useState, useEffect } from 'react';
import styles from './WebcamCapture.module.css';

// Aspect ratio options
type AspectRatio = '9:16' | '16:9' | '1:1' | '4:5' | '3:4';

const ASPECT_RATIOS: { id: AspectRatio; label: string; icon: string }[] = [
  { id: '9:16', label: 'Portrait', icon: '📱' },
  { id: '4:5', label: 'Instagram', icon: '📷' },
  { id: '1:1', label: 'Square', icon: '⬜' },
  { id: '3:4', label: 'Classic', icon: '🖼️' },
  { id: '16:9', label: 'Landscape', icon: '🖥️' },
];

interface WebcamCaptureProps {
  onCapture: (imageData: string) => void;
  onError?: (error: string) => void;
  mirrored?: boolean;
}

export default function WebcamCapture({
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
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('9:16'); // Default portrait

  // Parse aspect ratio to numeric value
  const getAspectRatioValue = (ratio: AspectRatio): number => {
    const [w, h] = ratio.split(':').map(Number);
    return w / h;
  };

  // Initialize webcam on mount
  useEffect(() => {
    let mounted = true;
    
    async function initCamera() {
      try {
        // Request high resolution for better quality stickers
        const mediaStream = await navigator.mediaDevices.getUserMedia({ 
          video: { 
            facingMode: 'user',
            width: { ideal: 1920, min: 640 },
            height: { ideal: 1080, min: 480 },
          },
          audio: false,
        });
        
        if (!mounted) {
          mediaStream.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (videoRef.current) {
          videoRef.current.srcObject = mediaStream;
          setStream(mediaStream);
          setIsReady(true);
          setError(null);
          
          // Log actual resolution for debugging
          videoRef.current.onloadedmetadata = () => {
            console.log(`📷 Webcam resolution: ${videoRef.current?.videoWidth}×${videoRef.current?.videoHeight}`);
          };
        }
      } catch (err) {
        if (!mounted) return;
        
        const errorMessage = err instanceof Error 
          ? `Camera access denied: ${err.message}` 
          : 'Camera access denied';
        setError(errorMessage);
        onError?.(errorMessage);
      }
    }
    
    initCamera();
    
    // Cleanup on unmount
    return () => {
      mounted = false;
      if (stream) {
        stream.getTracks().forEach(track => track.stop());
      }
    };
  }, [onError]);

  // Stop stream when component unmounts
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach(track => track.stop());
    };
  }, [stream]);

  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !canvasRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    const videoWidth = video.videoWidth;
    const videoHeight = video.videoHeight;
    
    // Calculate crop region based on aspect ratio
    const targetRatio = getAspectRatioValue(aspectRatio);
    const videoRatio = videoWidth / videoHeight;
    
    let cropWidth, cropHeight, cropX, cropY;
    
    if (targetRatio > videoRatio) {
      // Target is wider - crop top/bottom
      cropWidth = videoWidth;
      cropHeight = videoWidth / targetRatio;
      cropX = 0;
      cropY = (videoHeight - cropHeight) / 2;
    } else {
      // Target is taller - crop left/right
      cropHeight = videoHeight;
      cropWidth = videoHeight * targetRatio;
      cropX = (videoWidth - cropWidth) / 2;
      cropY = 0;
    }
    
    // Set canvas to cropped dimensions
    canvas.width = cropWidth;
    canvas.height = cropHeight;
    
    console.log(`📸 Capturing at: ${canvas.width}×${canvas.height} (${aspectRatio})`);
    
    // Apply mirror transformation if enabled
    if (mirrored) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    // Draw cropped region from video to canvas
    ctx.drawImage(
      video,
      cropX, cropY, cropWidth, cropHeight,  // Source rect
      0, 0, cropWidth, cropHeight           // Dest rect
    );

    // Convert to base64 and return
    const imageData = canvas.toDataURL('image/png');
    onCapture(imageData);
  }, [mirrored, onCapture, aspectRatio]);

  const startCountdown = useCallback(() => {
    setCountdown(3);
  }, []);

  useEffect(() => {
    if (countdown === null) return;

    if (countdown > 0) {
      const timer = setTimeout(() => {
        setCountdown(countdown - 1);
      }, 1000);
      return () => clearTimeout(timer);
    } else {
      // Countdown finished
      capturePhoto();
      setCountdown(null);
    }
  }, [countdown, capturePhoto]);

  // Calculate crop overlay dimensions for preview
  const getCropOverlayStyle = (): React.CSSProperties => {
    const ratio = getAspectRatioValue(aspectRatio);
    
    if (ratio > 1) {
      // Landscape - width limited
      return { aspectRatio: `${ratio}`, width: '100%', maxHeight: '100%' };
    } else {
      // Portrait - height limited
      return { aspectRatio: `${ratio}`, height: '100%', maxWidth: '100%' };
    }
  };

  return (
    <div className={styles.webcamContainer}>
      {/* Aspect Ratio Selector */}
      <div className={styles.aspectSelector}>
        {ASPECT_RATIOS.map((ar) => (
          <button
            key={ar.id}
            className={`${styles.aspectButton} ${aspectRatio === ar.id ? styles.aspectActive : ''}`}
            onClick={() => setAspectRatio(ar.id)}
            title={ar.label}
          >
            <span className={styles.aspectIcon}>{ar.icon}</span>
            <span className={styles.aspectLabel}>{ar.label}</span>
          </button>
        ))}
      </div>

      <div className={styles.videoWrapper}>
        {/* Show error if camera access failed */}
        {error && (
          <div className={styles.placeholder}>
            <span className={styles.cameraIcon}>🚫</span>
            <p>Camera Unavailable</p>
            <p className={styles.hint}>{error}</p>
          </div>
        )}
        
        {/* Show loading while initializing */}
        {!isReady && !error && (
          <div className={styles.placeholder}>
            <span className={styles.cameraIcon}>📷</span>
            <p>Initializing Camera...</p>
            <p className={styles.hint}>Please allow camera access</p>
          </div>
        )}
        
        {/* Countdown Overlay */}
        {countdown !== null && countdown > 0 && (
          <div className={styles.countdownOverlay}>
            <span className={styles.countdownNumber} key={countdown}>
              {countdown}
            </span>
          </div>
        )}
        
        {/* Crop frame overlay */}
        {isReady && !error && (
          <div className={styles.cropOverlay}>
            <div className={styles.cropFrame} style={getCropOverlayStyle()} />
          </div>
        )}
        
        {/* Live video feed */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={styles.video}
          style={{ 
            transform: mirrored ? 'scaleX(-1)' : 'none',
            display: isReady && !error ? 'block' : 'none',
          }}
        />
        <canvas ref={canvasRef} style={{ display: 'none' }} />
      </div>

      <button
        className={styles.captureButton}
        onClick={startCountdown}
        disabled={!isReady || countdown !== null}
      >
        <span className={styles.captureIcon}>📸</span>
        {countdown !== null ? 'Get Ready...' : 'Capture Photo'}
      </button>
    </div>
  );
}
