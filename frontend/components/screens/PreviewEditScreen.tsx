'use client';

/**
 * PreviewEditScreen Component
 * ===========================
 * Shown after capture if a template allows manual positioning.
 * 1. Hits /api/extract to remove background.
 * 2. Displays the template overlay.
 * 3. Allows the user to drag and scale their cutout.
 * 4. Yields the final position metadata to be processed by /api/generate.
 */

import { useState, useEffect, useRef } from 'react';
import styles from './PreviewEditScreen.module.css';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

interface PreviewEditScreenProps {
  selectedTemplate: string;
  rawImage: string; // Base64 from capture
  anchorMode?: string;
  onComplete: (extractedBase64: string, position: { x: number; y: number; scale: number; editorWidth: number; stickerWidth?: number }) => void;
  onCancel: () => void;
}

export default function PreviewEditScreen({
  selectedTemplate,
  rawImage,
  anchorMode = 'full_frame',
  onComplete,
  onCancel,
}: PreviewEditScreenProps) {
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractedSrc, setExtractedSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Sticker Transform State
  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });

  const containerRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLImageElement>(null);
  const stickerRef = useRef<HTMLImageElement>(null);

  useEffect(() => {
    let active = true;

    async function extract() {
      try {
        setIsExtracting(true);
        setError(null);

        // Convert base64 to Blob
        const blob = await fetch(rawImage).then((r) => r.blob());

        const formData = new FormData();
        formData.append('photo', blob, 'photo.jpg');
        formData.append('anchor_mode', anchorMode);

        const apiRes = await fetch(`${API_BASE_URL}/api/extract`, {
          method: 'POST',
          body: formData,
        });

        if (!apiRes.ok) {
          throw new Error('Failed to extract subject from background.');
        }

        const extractedBlob = await apiRes.blob();
        
        // Convert blob to base64 for easy passing later
        const reader = new FileReader();
        reader.onloadend = () => {
          if (active) {
            setExtractedSrc(reader.result as string);
            setIsExtracting(false);
          }
        };
        reader.readAsDataURL(extractedBlob);
      } catch (err) {
        if (active) {
          setError(err instanceof Error ? err.message : 'Extraction error');
          setIsExtracting(false);
        }
      }
    }

    extract();
    return () => {
      active = false;
    };
  }, [rawImage, anchorMode]);

  // Drag handlers
  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    // @ts-ignore
    e.target.setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!isDragging.current) return;
    setPos({
      x: e.clientX - dragStart.current.x,
      y: e.clientY - dragStart.current.y,
    });
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    isDragging.current = false;
    // @ts-ignore
    e.target.releasePointerCapture(e.pointerId);
  };

  const handleDone = () => {
    if (!extractedSrc || !containerRef.current || !templateRef.current) return;
    
    // We must pass the exact visual width of the template image on screen.
    // Because of object-fit: contain, the image might not fill the entire container.
    const container = containerRef.current;
    const templateImg = templateRef.current;
    
    // Calculate actual rendered dimensions of the template
    const imgRatio = templateImg.naturalWidth / templateImg.naturalHeight;
    const containerRatio = container.clientWidth / container.clientHeight;
    
    let renderedWidth = container.clientWidth;
    if (imgRatio < containerRatio) {
      // Image is height-constrained
      renderedWidth = container.clientHeight * imgRatio;
    }
    
    onComplete(extractedSrc, {
      x: pos.x,
      y: pos.y,
      scale: scale,
      editorWidth: renderedWidth,
      stickerWidth: stickerRef.current ? stickerRef.current.clientWidth : 0
    });
  };

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onCancel} disabled={isExtracting}>
          ← Back to Camera
        </button>
        <button className={styles.doneButton} onClick={handleDone} disabled={isExtracting || !!error}>
          ✨ Generate Photo
        </button>
      </div>

      <div className={styles.workspace}>
        {isExtracting && (
          <div className={styles.overlay}>
            <div className={styles.spinner} />
            <p>Extracting Subject...</p>
          </div>
        )}

        {error && (
          <div className={styles.overlay}>
            <p className={styles.errorText}>⚠️ {error}</p>
          </div>
        )}

        <div className={styles.canvasContainer} ref={containerRef}>
          {/* Template Background */}
          {selectedTemplate && (
            <img 
              ref={templateRef}
              src={`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/image`} 
              className={styles.bgTemplate} 
              alt="Background Template"
              draggable={false}
            />
          )}

          {/* Draggable Extracted Subject */}
          {!isExtracting && extractedSrc && (
            <div 
              className={styles.dragWrapper}
              style={{
                transform: `translate(${pos.x}px, ${pos.y}px) scale(${scale})`,
              }}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <img 
                ref={stickerRef}
                src={extractedSrc} 
                className={styles.extractedImg} 
                alt="Your Cutout" 
                draggable={false} 
              />
            </div>
          )}
        </div>
      </div>

      {/* Controls */}
      {!isExtracting && !error && (
        <div className={styles.controls}>
          <div className={styles.sliderGroup}>
            <span>Smaller</span>
            <input 
              type="range" 
              className={styles.slider}
              min="0.25" 
              max="3" 
              step="0.05" 
              value={scale} 
              onChange={e => setScale(parseFloat(e.target.value))} 
            />
            <span>Larger</span>
          </div>
          <p className={styles.helpText}>Drag the photo to move • Use slider to resize</p>
        </div>
      )}
    </div>
  );
}
