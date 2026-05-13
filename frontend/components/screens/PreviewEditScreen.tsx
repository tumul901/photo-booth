'use client';

import { useState, useEffect, useLayoutEffect, useRef, useCallback } from 'react';
import styles from './PreviewEditScreen.module.css';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

const GRID_COLS = 20;   // visual grid lines only
const GRID_ROWS = 20;
const SNAP_COLS = 100;  // snap resolution (1% steps — independent of visual grid)
const SNAP_ROWS = 100;
const RULER_SIZE = 18; // px — ruler bar thickness

interface PhotoSlot {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RenderBox {
  left: number;   // px offset from container left edge
  top: number;    // px offset from container top edge
  width: number;  // rendered template width in browser px
  height: number; // rendered template height in browser px
  sf: number;     // scale factor: template-native-px → browser-px
  natW: number;
  natH: number;
}

interface PreviewEditScreenProps {
  selectedTemplate: string;
  rawImage: string;
  anchorMode?: string;
  templateImageUrl?: string;
  skipConfigFetch?: boolean;
  photoSlot?: PhotoSlot | null;
  onComplete: (extractedBase64: string, position: { x: number; y: number; scale: number; editorWidth: number; stickerWidth?: number }) => void;
  onCancel: () => void;
}

export default function PreviewEditScreen({
  selectedTemplate,
  rawImage,
  anchorMode = 'full_frame',
  templateImageUrl,
  skipConfigFetch,
  photoSlot,
  onComplete,
  onCancel,
}: PreviewEditScreenProps) {
  const [isExtracting, setIsExtracting] = useState(true);
  const [extractedSrc, setExtractedSrc] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [templateConfig, setTemplateConfig] = useState<any>(null);

  const [pos, setPos] = useState({ x: 0, y: 0 });
  const [scale, setScale] = useState(1);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [renderBox, setRenderBox] = useState<RenderBox | null>(null);

  const isDragging = useRef(false);
  const dragStart = useRef({ x: 0, y: 0 });
  const hasAutoFit = useRef(false);
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const initialPinchDist = useRef<number | null>(null);
  const initialScale = useRef<number>(1);

  // Refs for stable access in pointer callbacks (avoids stale closures)
  const snapEnabledRef = useRef(snapEnabled);
  snapEnabledRef.current = snapEnabled;
  const renderBoxRef = useRef<RenderBox | null>(renderBox);
  renderBoxRef.current = renderBox;
  const posRef = useRef(pos);
  posRef.current = pos;
  // Live scale ref — updated by slider onInput without triggering React re-renders
  const liveScaleRef = useRef(scale);

  const containerRef = useRef<HTMLDivElement>(null);
  const templateRef = useRef<HTMLImageElement>(null);
  const stickerRef = useRef<HTMLImageElement>(null);
  const dragWrapperRef = useRef<HTMLDivElement>(null);
  const sliderRef = useRef<HTMLInputElement>(null);

  // Sync committed state → DOM without going through React reconciliation.
  // useLayoutEffect runs before paint so there's no visible flash.
  useLayoutEffect(() => {
    if (dragWrapperRef.current) {
      dragWrapperRef.current.style.transform = `translate(${pos.x}px, ${pos.y}px) scale(${scale})`;
    }
    if (sliderRef.current) sliderRef.current.value = String(scale);
    liveScaleRef.current = scale;
  }, [pos, scale]);

  // ── Render-box computation ──────────────────────────────────────────────────
  const computeRenderBox = useCallback((): RenderBox | null => {
    if (!containerRef.current || !templateRef.current) return null;
    const container = containerRef.current;
    const img = templateRef.current;
    const cW = container.clientWidth;
    const cH = container.clientHeight;
    const tNatW = img.naturalWidth;
    const tNatH = img.naturalHeight;
    if (!tNatW || !tNatH) return null;

    const tAspect = tNatW / tNatH;
    const cAspect = cW / cH;
    let tRendW: number, tRendH: number;
    if (tAspect >= cAspect) {
      tRendW = cW; tRendH = cW / tAspect;
    } else {
      tRendH = cH; tRendW = cH * tAspect;
    }
    const sf = tRendW / tNatW;
    const box: RenderBox = {
      left: (cW - tRendW) / 2,
      top: (cH - tRendH) / 2,
      width: tRendW,
      height: tRendH,
      sf,
      natW: tNatW,
      natH: tNatH,
    };
    setRenderBox(box);
    return box;
  }, []);

  // Recompute whenever the workspace container resizes (e.g. window resize)
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => computeRenderBox());
    ro.observe(el);
    return () => ro.disconnect();
  }, [computeRenderBox]);

  // ── Config fetch + extraction ───────────────────────────────────────────────
  useEffect(() => {
    let active = true;

    if (!templateConfig) {
      if (skipConfigFetch) {
        setTemplateConfig({ templateType: 'sticker' });
        return;
      }
      fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`)
        .then(res => res.json())
        .then(data => { if (active) setTemplateConfig(data); })
        .catch(err => console.error('Failed to load template config early:', err));
      return;
    }

    async function extract() {
      try {
        setIsExtracting(true);
        setError(null);
        const blob = await fetch(rawImage).then(r => r.blob());

        if (templateConfig?.templateType === 'frame') {
          setExtractedSrc(rawImage);
          setIsExtracting(false);
          return;
        }

        const formData = new FormData();
        formData.append('photo', blob, 'photo.jpg');
        formData.append('anchor_mode', anchorMode);

        const apiRes = await fetch(`${API_BASE_URL}/api/extract`, { method: 'POST', body: formData });
        if (!apiRes.ok) throw new Error('Failed to extract subject from background.');

        const reader = new FileReader();
        reader.onloadend = () => {
          if (active) { setExtractedSrc(reader.result as string); setIsExtracting(false); }
        };
        reader.readAsDataURL(await apiRes.blob());
      } catch (err) {
        if (active) { setError(err instanceof Error ? err.message : 'Extraction error'); setIsExtracting(false); }
      }
    }

    extract();
    return () => { active = false; };
  }, [rawImage, anchorMode, selectedTemplate, templateConfig]);

  useEffect(() => {
    if (isExtracting) hasAutoFit.current = false;
  }, [isExtracting]);

  // ── Slot placement ─────────────────────────────────────────────────────────
  // Shared helper: position + scale sticker so it fills 90% of the photo slot.
  const fitToSlot = useCallback((box: RenderBox) => {
    if (!photoSlot || !containerRef.current || !stickerRef.current) return;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;

    // Slot centre in container coordinates
    const slotCX = box.left + (photoSlot.x + photoSlot.width / 2) * box.sf;
    const slotCY = box.top + (photoSlot.y + photoSlot.height / 2) * box.sf;

    // dragWrapper transform-origin is the container centre, so pos=(0,0) means
    // the sticker centre sits exactly at the container centre.
    const initX = slotCX - cW / 2;
    const initY = slotCY - cH / 2;

    const sRendH = stickerRef.current.clientHeight;
    if (!sRendH) return;
    const initScale = Math.max(0.05, Math.min(4, (photoSlot.height * box.sf * 0.9) / sRendH));

    setPos({ x: initX, y: initY });
    setScale(initScale);
  }, [photoSlot]);

  // Called once when the extracted sticker image loads
  const handleStickerLoad = useCallback(() => {
    if (hasAutoFit.current) return;
    const box = computeRenderBox();
    if (!box) return;
    if (photoSlot) fitToSlot(box);
    hasAutoFit.current = true;
  }, [photoSlot, computeRenderBox, fitToSlot]);

  // Button: snap back to default slot position
  const resetToSlot = () => {
    const box = renderBoxRef.current;
    if (!box || !photoSlot) return;
    fitToSlot(box);
  };

  // ── Grid snap ──────────────────────────────────────────────────────────────
  // Uses refs so this callback never needs to be re-created.
  const applySnap = useCallback((raw: { x: number; y: number }): { x: number; y: number } => {
    const box = renderBoxRef.current;
    if (!snapEnabledRef.current || !box || !containerRef.current) return raw;
    const cW = containerRef.current.clientWidth;
    const cH = containerRef.current.clientHeight;

    // raw is relative to container centre → convert to absolute container coords
    const absX = raw.x + cW / 2;
    const absY = raw.y + cH / 2;

    // To template-native space
    const nX = (absX - box.left) / box.sf;
    const nY = (absY - box.top) / box.sf;

    // Snap to nearest grid intersection
    const stepX = box.natW / SNAP_COLS;
    const stepY = box.natH / SNAP_ROWS;
    const sX = Math.round(nX / stepX) * stepX;
    const sY = Math.round(nY / stepY) * stepY;

    // Back to container-centre-relative
    return {
      x: sX * box.sf + box.left - cW / 2,
      y: sY * box.sf + box.top - cH / 2,
    };
  }, []);

  // ── Drag & pinch handlers ──────────────────────────────────────────────────
  const handlePointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1) {
      isDragging.current = true;
      dragStart.current = { x: e.clientX - pos.x, y: e.clientY - pos.y };
    } else if (pointers.current.size === 2) {
      const pts = Array.from(pointers.current.values());
      initialPinchDist.current = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      initialScale.current = scale;
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!pointers.current.has(e.pointerId)) return;
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (pointers.current.size === 1 && isDragging.current) {
      const raw = { x: e.clientX - dragStart.current.x, y: e.clientY - dragStart.current.y };
      setPos(applySnap(raw));
    } else if (pointers.current.size === 2 && initialPinchDist.current !== null) {
      const pts = Array.from(pointers.current.values());
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      if (initialPinchDist.current > 10) {
        setScale(Math.min(Math.max(initialScale.current * (dist / initialPinchDist.current), 0.05), 4));
      }
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    (e.target as Element).releasePointerCapture(e.pointerId);
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) initialPinchDist.current = null;
    if (pointers.current.size === 0) {
      isDragging.current = false;
    } else if (pointers.current.size === 1) {
      const rem = Array.from(pointers.current.values())[0];
      dragStart.current = { x: rem.x - pos.x, y: rem.y - pos.y };
    }
  };

  // Slider: update DOM directly — zero React re-renders during drag
  const handleSliderInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = parseFloat((e.target as HTMLInputElement).value);
    liveScaleRef.current = v;
    if (dragWrapperRef.current) {
      const p = posRef.current;
      dragWrapperRef.current.style.transform = `translate(${p.x}px, ${p.y}px) scale(${v})`;
    }
  };

  // Commit to React state on release so handleDone reads the right value
  const commitSliderScale = () => setScale(liveScaleRef.current);

  const handleDone = () => {
    if (!extractedSrc || !containerRef.current || !templateRef.current) return;
    const container = containerRef.current;
    const img = templateRef.current;
    const imgRatio = img.naturalWidth / img.naturalHeight;
    const cRatio = container.clientWidth / container.clientHeight;
    let renderedWidth = container.clientWidth;
    if (imgRatio < cRatio) renderedWidth = container.clientHeight * imgRatio;

    onComplete(extractedSrc, {
      x: pos.x, y: pos.y, scale,
      editorWidth: renderedWidth,
      stickerWidth: stickerRef.current?.clientWidth ?? 0,
    });
  };

  // ── Grid / ruler markup (pre-computed for readability) ─────────────────────
  const gridSvg = renderBox && snapEnabled ? (
    <svg
      className={styles.gridOverlay}
      style={{ left: renderBox.left, top: renderBox.top, width: renderBox.width, height: renderBox.height }}
    >
      {Array.from({ length: GRID_COLS - 1 }, (_, i) => {
        const isMajor = (i + 1) % 4 === 0; // every 20%
        return (
          <line key={`v${i}`}
            x1={`${(i + 1) * (100 / GRID_COLS)}%`} y1="0"
            x2={`${(i + 1) * (100 / GRID_COLS)}%`} y2="100%"
            stroke={isMajor ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)'}
            strokeWidth={isMajor ? 1 : 0.5}
            strokeDasharray={isMajor ? '4 4' : '2 6'}
          />
        );
      })}
      {Array.from({ length: GRID_ROWS - 1 }, (_, i) => {
        const isMajor = (i + 1) % 4 === 0;
        return (
          <line key={`h${i}`}
            x1="0" y1={`${(i + 1) * (100 / GRID_ROWS)}%`}
            x2="100%" y2={`${(i + 1) * (100 / GRID_ROWS)}%`}
            stroke={isMajor ? 'rgba(255,255,255,0.28)' : 'rgba(255,255,255,0.1)'}
            strokeWidth={isMajor ? 1 : 0.5}
            strokeDasharray={isMajor ? '4 4' : '2 6'}
          />
        );
      })}
    </svg>
  ) : null;

  const rulerH = renderBox && snapEnabled ? (
    <svg
      className={styles.rulerH}
      style={{ left: renderBox.left, top: renderBox.top, width: renderBox.width, height: RULER_SIZE }}
    >
      <rect width="100%" height={RULER_SIZE} fill="rgba(15,15,35,0.75)" />
      {Array.from({ length: GRID_COLS + 1 }, (_, i) => {
        const pct = (i / GRID_COLS) * 100;
        const isMajor = i % 4 === 0; // every 20%
        const showLabel = i > 0 && i < GRID_COLS && i % 4 === 0;
        return (
          <g key={i}>
            <line x1={`${pct}%`} y1={isMajor ? 0 : 7} x2={`${pct}%`} y2={RULER_SIZE}
              stroke={isMajor ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.3)'} strokeWidth="1" />
            {showLabel && (
              <text x={`${pct}%`} y={RULER_SIZE - 3} textAnchor="middle"
                fontSize="7" fill="rgba(255,255,255,0.6)" fontFamily="monospace">
                {Math.round(i * (100 / GRID_COLS))}%
              </text>
            )}
          </g>
        );
      })}
    </svg>
  ) : null;

  const rulerV = renderBox && snapEnabled ? (
    <svg
      className={styles.rulerV}
      style={{ left: renderBox.left, top: renderBox.top, width: RULER_SIZE, height: renderBox.height }}
    >
      <rect width={RULER_SIZE} height="100%" fill="rgba(15,15,35,0.75)" />
      {Array.from({ length: GRID_ROWS + 1 }, (_, i) => {
        const yPx = (renderBox.height * i) / GRID_ROWS;
        const isMajor = i % 4 === 0;
        const showLabel = i > 0 && i < GRID_ROWS && i % 4 === 0;
        return (
          <g key={i}>
            <line x1={isMajor ? 0 : 7} y1={yPx} x2={RULER_SIZE} y2={yPx}
              stroke={isMajor ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.3)'} strokeWidth="1" />
            {showLabel && (
              <text
                x={RULER_SIZE / 2} y={yPx}
                fontSize="7" fill="rgba(255,255,255,0.6)" fontFamily="monospace"
                textAnchor="middle" dominantBaseline="middle"
                transform={`rotate(-90 ${RULER_SIZE / 2} ${yPx})`}
              >
                {Math.round(i * (100 / GRID_ROWS))}%
              </text>
            )}
          </g>
        );
      })}
    </svg>
  ) : null;

  const slotOutline = renderBox && photoSlot ? (
    <div
      className={styles.slotOutline}
      style={{
        left: renderBox.left + photoSlot.x * renderBox.sf,
        top: renderBox.top + photoSlot.y * renderBox.sf,
        width: photoSlot.width * renderBox.sf,
        height: photoSlot.height * renderBox.sf,
      }}
    />
  ) : null;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onCancel} disabled={isExtracting}>
          ←<span className={styles.backText}> Back to Camera</span>
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
          {/* Template background */}
          {selectedTemplate && (
            <img
              ref={templateRef}
              src={templateImageUrl || `${API_BASE_URL}/api/admin/templates/${selectedTemplate}/image`}
              className={styles.bgTemplate}
              alt="Background Template"
              draggable={false}
              onLoad={computeRenderBox}
            />
          )}

          {/* Grid lines */}
          {gridSvg}

          {/* Rulers (overlaid on top-left edges of the template area) */}
          {rulerH}
          {rulerV}

          {/* Photo slot boundary */}
          {slotOutline}

          {/* Draggable sticker */}
          {!isExtracting && extractedSrc && (
            <div
              ref={dragWrapperRef}
              className={styles.dragWrapper}
              onPointerDown={handlePointerDown}
              onPointerMove={handlePointerMove}
              onPointerUp={handlePointerUp}
              onPointerCancel={handlePointerUp}
            >
              <img
                ref={stickerRef}
                src={extractedSrc}
                className={styles.extractedImg}
                style={{
                  filter: templateConfig?.stickerFilter === 'bw'
                    ? 'grayscale(1) contrast(1.2)'
                    : undefined,
                }}
                alt="Your Cutout"
                draggable={false}
                onLoad={handleStickerLoad}
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
              ref={sliderRef}
              type="range"
              className={styles.slider}
              min="0.05" max="3" step="0.02"
              defaultValue={scale}
              onChange={handleSliderInput}
              onPointerUp={commitSliderScale}
              onKeyUp={commitSliderScale}
            />
            <span>Larger</span>
          </div>
          <div className={styles.controlRow}>
            <button
              className={`${styles.snapBtn} ${snapEnabled ? styles.snapBtnActive : ''}`}
              onClick={() => setSnapEnabled(v => !v)}
            >
              ⊞ {snapEnabled ? 'Snap ON' : 'Snap OFF'}
            </button>
            {photoSlot && (
              <button className={styles.resetBtn} onClick={resetToSlot}>
                ⌖ Reset Position
              </button>
            )}
          </div>
          <p className={styles.helpText}>Drag the photo to move • Use slider or pinch to resize</p>
        </div>
      )}
    </div>
  );
}
