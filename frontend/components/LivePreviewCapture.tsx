'use client';

/**
 * LivePreviewCapture Component
 * ============================
 * Real-time preview showing webcam feed overlaid onto template slot.
 * Users can see exactly how they'll appear before capture.
 * 
 * Features:
 * - Template image as background
 * - Webcam feed positioned in slot area
 * - Face anchor point indicator
 * - Countdown timer and capture
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import styles from './LivePreviewCapture.module.css';

interface SlotConfig {
  slotId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchor: {
    targetX: number;
    targetY: number;
  };
  desiredFaceRatio?: number;
}

interface TemplateConfig {
  templateId: string;
  name: string;
  dimensions: { width: number; height: number };
  slots: SlotConfig[];
}

interface LivePreviewCaptureProps {
  templateId: string;
  templateImageUrl: string;
  templateConfig: TemplateConfig | null;
  onCapture: (imageData: string) => void;
  onError?: (error: string) => void;
  mirrored?: boolean;
}

export default function LivePreviewCapture({
  templateId,
  templateImageUrl,
  templateConfig,
  onCapture,
  onError,
  mirrored = true,
}: LivePreviewCaptureProps) {
  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const templateImgRef = useRef<HTMLImageElement | null>(null);
  const animationRef = useRef<number>(0);
  
  // State
  const [isReady, setIsReady] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [countdown, setCountdown] = useState<number | null>(null);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [displayScale, setDisplayScale] = useState(1);
  
  // Get first slot for preview
  const slot = templateConfig?.slots?.[0];

  // Debug: Monitor template config
  useEffect(() => {
    console.log('LivePreviewCapture: TemplateConfig changed:', templateConfig);
    if (templateConfig?.slots?.length) {
      console.log('LivePreviewCapture: Slot found:', templateConfig.slots[0]);
    } else {
      console.warn('LivePreviewCapture: No slots in template config');
    }
  }, [templateConfig]);

  // Initialize webcam
  useEffect(() => {
    let mounted = true;
    
    async function initCamera() {
      try {
        console.log('LivePreviewCapture: Requesting camera access...');
        const mediaStream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: 'user',
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
          audio: false,
        });
        
        if (!mounted) {
          console.log('LivePreviewCapture: Component unmounted, stopping tracks');
          mediaStream.getTracks().forEach(track => track.stop());
          return;
        }
        
        if (videoRef.current) {
          console.log('LivePreviewCapture: Camera stream obtained, checking video readiness...');
          videoRef.current.srcObject = mediaStream;
          setStream(mediaStream);
          
          // Wait for video metadata to load
          const video = videoRef.current;
          
          const checkVideoReady = () => {
            if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
              console.log(`✅ Video ready: ${video.videoWidth}x${video.videoHeight}`);
              // Ensure video is playing
              video.play().catch(e => console.error("Play error:", e));
              setVideoReady(true);
              setIsReady(true);
            } else {
              console.log(`⏳ Waiting for video... readyState=${video.readyState}, dimensions=${video.videoWidth}x${video.videoHeight}`);
              setTimeout(checkVideoReady, 100);
            }
          };
          
          video.onloadedmetadata = checkVideoReady;
          // Also check immediately in case metadata already loaded
          setTimeout(checkVideoReady, 100);
        }
      } catch (err) {
        console.error('LivePreviewCapture: Camera initialization failed:', err);
        if (!mounted) return;
        const errMsg = err instanceof Error ? err.message : 'Camera access denied';
        setError(errMsg);
        onError?.(errMsg);
      }
    }
    
    initCamera();
    
    return () => {
      mounted = false;
      stream?.getTracks().forEach(track => track.stop());
    };
  }, []);

  // Cleanup stream on unmount
  useEffect(() => {
    return () => {
      stream?.getTracks().forEach(track => track.stop());
    };
  }, [stream]);

  // Load template image
  useEffect(() => {
    console.log('LivePreviewCapture: Loading template image:', templateImageUrl);
    const img = new Image();
    img.onload = () => {
      console.log('LivePreviewCapture: Template image loaded successfully');
      templateImgRef.current = img;
      setTemplateLoaded(true);
    };
    img.onerror = (e) => {
      console.error('LivePreviewCapture: Template image load failed:', e);
      setError('Failed to load template image');
    };
    img.src = templateImageUrl;
  }, [templateImageUrl]);

  // Calculate display scale to fit container
  useEffect(() => {
    if (!containerRef.current || !templateConfig) return;
    
    const container = containerRef.current;
    const maxWidth = container.clientWidth - 20;
    const maxHeight = window.innerHeight - 250;
    
    const scaleX = maxWidth / templateConfig.dimensions.width;
    const scaleY = maxHeight / templateConfig.dimensions.height;
    setDisplayScale(Math.min(scaleX, scaleY, 1));
  }, [templateConfig, templateLoaded]);

  // Animation loop for live preview
  useEffect(() => {
    if (!isReady || !templateLoaded || !templateConfig || !slot) {
      console.log('LivePreviewCapture: Waiting for prerequisites:', { isReady, templateLoaded, hasConfig: !!templateConfig, hasSlot: !!slot });
      return;
    }
    
    console.log('LivePreviewCapture: Starting animation loop');
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const video = videoRef.current;
    const templateImg = templateImgRef.current;
    
    if (!canvas || !ctx || !video || !templateImg) return;
    
    // Set canvas to scaled template size
    canvas.width = templateConfig.dimensions.width * displayScale;
    canvas.height = templateConfig.dimensions.height * displayScale;
    
    let frameCount = 0;
    
    function draw() {
      if (!ctx || !video || !templateImg || !slot) return;
      
      // Recalculate actual scale based on current canvas size
      const actualScaleX = canvas!.width / templateConfig.dimensions.width;
      const actualScaleY = canvas!.height / templateConfig.dimensions.height;
      const actualScale = Math.min(actualScaleX, actualScaleY);
      
      // Clear canvas
      ctx.clearRect(0, 0, canvas!.width, canvas!.height);
      
      // Get video dimensions
      const videoW = video.videoWidth;
      const videoH = video.videoHeight;
      
      if (!videoW || !videoH) {
        // console.error('❌ Video dimensions are 0!'); // Reduced log spam
        animationRef.current = requestAnimationFrame(draw);
        return;
      }
      
      // USE actualScale instead of displayScale!
      const slotX = slot.x * actualScale;
      const slotY = slot.y * actualScale;
      const slotW = slot.width * actualScale;
      const slotH = slot.height * actualScale;
      
      // 1. Draw TEMPLATE (Background)
      ctx.drawImage(templateImg, 0, 0, canvas!.width, canvas!.height);
      
      // 2. Draw VIDEO (Foreground - Clipped to Slot)
      // This ensures video is visible even if template has no transparency
      ctx.save();
      
      // Define clipping path (the slot rectangle)
      ctx.beginPath();
      ctx.rect(slotX, slotY, slotW, slotH);
      ctx.clip();
      
      // Draw video inside the clipped area
      if (mirrored) {
        ctx.save();
        // Translate to the RIGHT edge of the slot
        ctx.translate(slotX + slotW, slotY);
        // Flip horizontally
        ctx.scale(-1, 1);
        // Draw from 0,0 (which is now top-right of slot due to transform + scale)
        ctx.drawImage(video, 0, 0, slotW, slotH);
        ctx.restore();
      } else {
        ctx.drawImage(video, slotX, slotY, slotW, slotH);
      }
      
      ctx.restore(); // Restore context (removes clip)
      
      // Draw slot border for visibility (optional - subtle shadow)
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.2)';
      ctx.lineWidth = 1;
      ctx.strokeRect(slotX, slotY, slotW, slotH);
      
      // Draw anchor point config
      const anchorX = (slot.x + slot.anchor.targetX) * displayScale;
      const anchorY = (slot.y + slot.anchor.targetY) * displayScale;
      
      // Anchor crosshair
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(anchorX - 15, anchorY);
      ctx.lineTo(anchorX + 15, anchorY);
      ctx.moveTo(anchorX, anchorY - 15);
      ctx.lineTo(anchorX, anchorY + 15);
      ctx.stroke();
      
      // Anchor circle
      ctx.beginPath();
      ctx.arc(anchorX, anchorY, 8, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(255, 204, 0, 0.6)';
      ctx.fill();
      ctx.strokeStyle = '#ffcc00';
      ctx.stroke();
      
      // Continue animation
      animationRef.current = requestAnimationFrame(draw);
    }
    
    draw();
    
    return () => {
      cancelAnimationFrame(animationRef.current);
    };
  }, [isReady, templateLoaded, templateConfig, slot, displayScale, mirrored]);

  // Capture photo
  const capturePhoto = useCallback(() => {
    if (!videoRef.current || !templateConfig || !slot) return;
    
    const video = videoRef.current;
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    
    // Create capture canvas at slot dimensions
    const captureCanvas = document.createElement('canvas');
    captureCanvas.width = slot.width;
    captureCanvas.height = slot.height;
    const ctx = captureCanvas.getContext('2d');
    if (!ctx) return;
    
    // Calculate crop from video to fit slot
    const videoAspect = videoW / videoH;
    const slotAspect = slot.width / slot.height;
    
    let srcX, srcY, srcW, srcH;
    
    if (videoAspect > slotAspect) {
      // Video is wider - crop sides
      srcH = videoH;
      srcW = videoH * slotAspect;
      srcX = (videoW - srcW) / 2;
      srcY = 0;
    } else {
      // Video is taller - crop top/bottom
      srcW = videoW;
      srcH = videoW / slotAspect;
      srcX = 0;
      srcY = (videoH - srcH) / 2;
    }
    
    // Apply mirror if needed
    if (mirrored) {
      ctx.translate(slot.width, 0);
      ctx.scale(-1, 1);
    }
    
    // Draw cropped video to canvas
    ctx.drawImage(
      video,
      srcX, srcY, srcW, srcH,
      0, 0, slot.width, slot.height
    );
    
    // Convert to base64
    const imageData = captureCanvas.toDataURL('image/png');
    onCapture(imageData);
  }, [templateConfig, slot, mirrored, onCapture]);

  // Start countdown
  const startCountdown = useCallback(() => {
    setCountdown(3);
  }, []);

  // Countdown timer
  useEffect(() => {
    if (countdown === null) return;
    
    if (countdown > 0) {
      const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
      return () => clearTimeout(timer);
    } else {
      capturePhoto();
      setCountdown(null);
    }
  }, [countdown, capturePhoto]);

  return (
    <div className={styles.container} ref={containerRef}>
      <div className={styles.header}>
        <h2 className={styles.title}>Position yourself in the frame</h2>
        <p className={styles.subtitle}>Align your face with the yellow target</p>
      </div>
      
      <div className={styles.previewWrapper}>
        {/* Hidden video element for webcam */}
        <video
          ref={videoRef}
          className="hidden" 
          style={{ 
            visibility: 'hidden', // Better than display: none
            width: '1280px',      // Explicit size
            height: '720px', 
            position: 'absolute', // Remove from flow
            pointerEvents: 'none', // Click-through
            top: 0,
            left: 0,
            zIndex: -1
          }} 
          playsInline
          muted
          autoPlay
        />
        
        {/* Loading states */}
        {(!isReady || !templateLoaded) && !error && (
          <div className={styles.loading}>
            {!templateLoaded ? 'Loading template...' : 'Initializing camera...'}
          </div>
        )}
        
        {/* Error state */}
        {error && (
          <div className={styles.error}>
            <span>🚫</span>
            <p>{error}</p>
          </div>
        )}
        
        {/* Live preview canvas */}
        <canvas
          ref={canvasRef}
          className={styles.canvas}
          style={{ display: isReady && templateLoaded ? 'block' : 'none' }}
        />
        
        {/* Countdown overlay */}
        {countdown !== null && countdown > 0 && (
          <div className={styles.countdownOverlay}>
            <span className={styles.countdownNumber} key={countdown}>
              {countdown}
            </span>
          </div>
        )}
      </div>
      
      <button
        className={styles.captureButton}
        onClick={startCountdown}
        disabled={!isReady || !templateLoaded || countdown !== null}
      >
        <span className={styles.captureIcon}>📸</span>
        {countdown !== null ? 'Get Ready...' : 'Capture Photo'}
      </button>
      
      <p className={styles.hint}>
        💡 Position your face on the yellow crosshair for best results
      </p>
    </div>
  );
}
