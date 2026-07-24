'use client';

/**
 * TemplateEditor Component
 * ========================
 * Visual editor for template slot configuration.
 * 
 * Features:
 * - Display template image on canvas
 * - Draw slot rectangles with mouse drag
 * - Click to set face anchor point within slot
 * - Preview and save configuration
 */

import { useRef, useState, useEffect, useCallback } from 'react';
import styles from './TemplateEditor.module.css';

// Types
interface SlotConfig {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  anchorX: number;  // Relative anchor X within slot (0-1)
  anchorY: number;  // Relative anchor Y within slot (0-1)
}

interface FontItem {
  name: string;
  path: string;
}

interface TextConfig {
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontPath: string;
  fontName: string;
  maxWidth: number;
  align: 'left' | 'center' | 'right';
  uppercase: boolean;
  rotation: number;
  // Extended styling
  letterSpacing: number;   // inter-character spacing, px (can be negative)
  strokeWidth: number;     // outline width, px (0 = none)
  strokeColor: string;
  shadowBlur: number;      // drop-shadow blur radius, px (0 = none)
  shadowColor: string;
  shadowOffsetX: number;
  shadowOffsetY: number;
  opacity: number;         // 0-100
}

const defaultTextConfig = (): TextConfig => ({
  x: 100,
  y: 100,
  fontSize: 60,
  color: '#FFFFFF',
  fontPath: '',
  fontName: '',
  maxWidth: 0,
  align: 'left',
  uppercase: false,
  rotation: 0,
  letterSpacing: 0,
  strokeWidth: 0,
  strokeColor: '#000000',
  shadowBlur: 0,
  shadowColor: '#000000',
  shadowOffsetX: 0,
  shadowOffsetY: 0,
  opacity: 100,
});

interface SnapGuide {
  axis: 'x' | 'y'; // 'x' = vertical line, 'y' = horizontal line
  position: number; // in image (unscaled) coordinates
  label?: string;   // e.g. 'center', '⅓', 'edge' — shown on the guide
}

const SNAP_THRESHOLD = 12; // px in image space

// Instagram-story style snapping: the dragged box's left/center/right edges snap
// to the canvas edges, center and rule-of-thirds lines (same for top/mid/bottom).
// Corners emerge naturally when an X ref and a Y ref both catch at once.
function computeSnap(
  nx: number, ny: number,
  fgW: number, fgH: number,
  canvasW: number, canvasH: number,
): { snappedX: number; snappedY: number; guides: SnapGuide[] } {
  const xRefs = [0, canvasW / 3, canvasW / 2, (2 * canvasW) / 3, canvasW];
  const yRefs = [0, canvasH / 3, canvasH / 2, (2 * canvasH) / 3, canvasH];

  const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
  const xLabel = (r: number) =>
    near(r, 0) || near(r, canvasW) ? 'edge' : near(r, canvasW / 2) ? 'center' : '⅓';
  const yLabel = (r: number) =>
    near(r, 0) || near(r, canvasH) ? 'edge' : near(r, canvasH / 2) ? 'center' : '⅓';

  let bestDX = 0, minDX = SNAP_THRESHOLD + 1, bestXRef = 0;
  for (const a of [nx, nx + fgW / 2, nx + fgW]) {
    for (const r of xRefs) {
      const dist = Math.abs(a - r);
      if (dist < minDX) { minDX = dist; bestDX = r - a; bestXRef = r; }
    }
  }

  let bestDY = 0, minDY = SNAP_THRESHOLD + 1, bestYRef = 0;
  for (const a of [ny, ny + fgH / 2, ny + fgH]) {
    for (const r of yRefs) {
      const dist = Math.abs(a - r);
      if (dist < minDY) { minDY = dist; bestDY = r - a; bestYRef = r; }
    }
  }

  const snappedX = minDX < SNAP_THRESHOLD ? nx + bestDX : nx;
  const snappedY = minDY < SNAP_THRESHOLD ? ny + bestDY : ny;
  const guides: SnapGuide[] = [];
  if (minDX < SNAP_THRESHOLD) guides.push({ axis: 'x', position: bestXRef, label: xLabel(bestXRef) });
  if (minDY < SNAP_THRESHOLD) guides.push({ axis: 'y', position: bestYRef, label: yLabel(bestYRef) });
  return { snappedX, snappedY, guides };
}

interface TemplateConfig {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker' | 'magazine';
  compositeMode: 'background' | 'overlay' | 'magazine';
  stickerFilter: 'none' | 'bw' | 'sketch';
  pngUrl: string;
  fg_path?: string;
  anchorMode: 'face_center' | 'eyes' | 'none' | 'full_frame' | 'baseline';
  baseline?: { x1: number; x2: number; y: number } | null;
  dimensions: { width: number; height: number };
  slots: SlotConfig[];
  desiredFaceRatio: number;
  minZoom: number;
  maxZoom: number;
  showVisualGuide: boolean;
  allowManualPositioning: boolean;
  name_text?: TextConfig;
  designation_text?: TextConfig;
  fg_offset?: { x: number; y: number };
  luggage_card_mode: boolean;
  print_dpi: number;
  print_width_mm: number;
  print_height_mm: number;
  output_format: string;
}

interface TemplateEditorProps {
  templateId: string;
  templateName: string;
  imageUrl: string;
  initialConfig?: Partial<TemplateConfig>;
  onSave: (config: TemplateConfig) => void;
  onCancel: () => void;
}

type EditorMode = 'select' | 'draw' | 'anchor' | 'fg' | 'baseline';

interface Baseline { x1: number; x2: number; y: number }

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function TemplateEditor({
  templateId,
  templateName,
  imageUrl,
  initialConfig,
  onSave,
  onCancel,
}: TemplateEditorProps) {
  // Canvas refs
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  
  // Image state
  const [imageLoaded, setImageLoaded] = useState(false);
  const [imageDimensions, setImageDimensions] = useState({ width: 0, height: 0 });
  const [scale, setScale] = useState(1); // Display scale for fitting in viewport
  
  // Loading state for fetching config
  const [configLoaded, setConfigLoaded] = useState(false);
  
  // Editor state
  const [mode, setMode] = useState<EditorMode>('draw');
  const [slots, setSlots] = useState<SlotConfig[]>([]);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawCurrent, setDrawCurrent] = useState({ x: 0, y: 0 });
  
  // FG overlay for magazine mode
  const [fgImageRef, setFgImageRef] = useState<HTMLImageElement | null>(null);
  const [showFgOverlay, setShowFgOverlay] = useState(true);

  // Config settings
  const [templateType, setTemplateType] = useState<'frame' | 'sticker' | 'magazine'>('sticker');
  const [compositeMode, setCompositeMode] = useState<'background' | 'overlay' | 'magazine'>('background');
  const [stickerFilter, setStickerFilter] = useState<'none' | 'bw' | 'sketch'>('none');
  const [anchorMode, setAnchorMode] = useState<'face_center' | 'eyes' | 'none' | 'full_frame' | 'baseline'>('face_center');

  // Baseline placement: one horizontal segment encoding subject bottom (y),
  // horizontal center (midpoint) and target width (length). `baselineDraft` is
  // the live segment during a drag.
  const [baseline, setBaseline] = useState<Baseline | null>(null);
  const [baselineDraft, setBaselineDraft] = useState<Baseline | null>(null);
  const isDrawingBaseline = useRef(false);
  const [desiredFaceRatio, setDesiredFaceRatio] = useState(0.25);
  const [minZoom, setMinZoom] = useState(0.5);
  const [maxZoom, setMaxZoom] = useState(2.5);
  const [showVisualGuide, setShowVisualGuide] = useState(false);
  const [allowManualPositioning, setAllowManualPositioning] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  // % of the template PNG that is transparent (its "photo window"). ~0 = solid card.
  const [pngTransparentPct, setPngTransparentPct] = useState<number | null>(null);

  // Text overlay configs (magazine + sticker/luggage card)
  const [nameTextConfig, setNameTextConfig] = useState<TextConfig>(defaultTextConfig());
  const [designationTextConfig, setDesignationTextConfig] = useState<TextConfig>({ ...defaultTextConfig(), y: 180, fontSize: 40 });
  const [hasNameText, setHasNameText] = useState(false);
  const [hasDesignationText, setHasDesignationText] = useState(false);

  // Custom fonts
  const [fonts, setFonts] = useState<FontItem[]>([]);
  // Fonts successfully loaded into the browser (via FontFace) so the canvas can
  // preview text in the exact typeface the backend composites with.
  const [loadedFontNames, setLoadedFontNames] = useState<Set<string>>(new Set());
  const attemptedFontsRef = useRef<Set<string>>(new Set());

  // Sample strings shown inside the WYSIWYG text boxes so the admin sees real
  // extent/wrapping instead of guessing from a symbolic marker.
  const [namePreview, setNamePreview] = useState('Rajesh Kumar');
  const [designationPreview, setDesignationPreview] = useState('Marketing Head');
  const [uploadingFont, setUploadingFont] = useState(false);

  // Screen-space (axis-aligned) hit rectangles for the drawn text boxes, refreshed
  // each redraw so the whole box is grabbable — not just a tiny dot.
  const textHitRectsRef = useRef<Record<'name' | 'designation', { x: number; y: number; w: number; h: number } | null>>({ name: null, designation: null });
  // Offset between the grabbed point and the text anchor, so dragging doesn't snap
  // the anchor to the cursor (the box stays under the finger where you grabbed it).
  const textDragOffsetRef = useRef<{ dx: number; dy: number }>({ dx: 0, dy: 0 });

  // Luggage card printing mode
  const [luggageCardMode, setLuggageCardMode] = useState(false);
  const [printDpi, setPrintDpi] = useState<300 | 600>(300);
  const [printWidthMm, setPrintWidthMm] = useState(86.0);
  const [printHeightMm, setPrintHeightMm] = useState(54.0);
  const [outputFormat, setOutputFormat] = useState<'png' | 'jpeg_print'>('png');

  // Dragging state for text markers
  const [draggingText, setDraggingText] = useState<'name' | 'designation' | null>(null);

  // FG drag + snap guide state
  const [fgOffset, setFgOffset] = useState({ x: 0, y: 0 });
  const [isDraggingFg, setIsDraggingFg] = useState(false);
  const [activeGuides, setActiveGuides] = useState<SnapGuide[]>([]);
  const fgDragAnchorRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number } | null>(null);

  // Magnet snapping (edges/center/thirds). Toggleable so the admin can "lock in"
  // an exact position without the guides pulling it around.
  const [snapEnabled, setSnapEnabled] = useState(true);
  // Live cursor position (image-native px), shown in the ruler readout HUD.
  const [hoverPos, setHoverPos] = useState<{ x: number; y: number } | null>(null);

  // Load available custom fonts
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/admin/fonts`)
      .then(r => r.json())
      .then(d => setFonts(d.fonts ?? []))
      .catch(() => {});
  }, []);

  // Register each custom font in the browser so text previews render in the real
  // typeface. Family is namespaced ("tpl-<name>") so it can't collide with an
  // installed system font and so fallback detection stays exact.
  useEffect(() => {
    if (!fonts.length || typeof (document as any).fonts?.add !== 'function') return;
    fonts.forEach(f => {
      if (attemptedFontsRef.current.has(f.name)) return;
      attemptedFontsRef.current.add(f.name);
      try {
        const url = `${API_BASE_URL}/api/admin/fonts/${encodeURIComponent(f.name)}/file`;
        const face = new FontFace(`tpl-${f.name}`, `url(${url})`);
        face.load()
          .then(loaded => {
            (document as any).fonts.add(loaded);
            setLoadedFontNames(prev => {
              const next = new Set(prev);
              next.add(f.name);
              return next;
            });
          })
          .catch(() => { /* font stays as sans-serif fallback in preview */ });
      } catch { /* FontFace unsupported — fallback preview */ }
    });
  }, [fonts]);

  // Load FG image whenever compositeMode becomes 'magazine'
  useEffect(() => {
    if (compositeMode !== 'magazine') {
      setFgImageRef(null);
      return;
    }
    const fg = new Image();
    fg.onload = () => setFgImageRef(fg);
    fg.onerror = () => setFgImageRef(null);
    fg.src = `${API_BASE_URL}/api/admin/templates/${templateId}/fg-image?t=${Date.now()}`;
  }, [compositeMode, templateId]);

  // Fetch existing config when editor opens
  useEffect(() => {
    async function loadExistingConfig() {
      try {
        const res = await fetch(`${API_BASE_URL}/api/admin/templates/${templateId}/config`);
        if (!res.ok) {
          console.log('No existing config found, using defaults');
          setConfigLoaded(true);
          return;
        }

        const config = await res.json();
        console.log('Loaded existing config:', config);

        if (typeof config._pngTransparentPct === 'number') setPngTransparentPct(config._pngTransparentPct);

        // Apply loaded config to state
        if (config.templateType) setTemplateType(config.templateType);
        if (config.compositeMode) setCompositeMode(config.compositeMode);
        if (config.stickerFilter) setStickerFilter(config.stickerFilter);
        if (config.anchorMode) setAnchorMode(config.anchorMode);
        if (config.desiredFaceRatio) setDesiredFaceRatio(config.desiredFaceRatio);
        if (config.minZoom) setMinZoom(config.minZoom);
        if (config.maxZoom) setMaxZoom(config.maxZoom);
        if (typeof config.showVisualGuide === 'boolean') setShowVisualGuide(config.showVisualGuide);
        if (typeof config.allowManualPositioning === 'boolean') setAllowManualPositioning(config.allowManualPositioning);
        if (config.fg_offset && typeof config.fg_offset === 'object') {
          setFgOffset({ x: config.fg_offset.x || 0, y: config.fg_offset.y || 0 });
        }
        if (config.baseline && typeof config.baseline === 'object'
            && typeof config.baseline.y === 'number') {
          setBaseline({
            x1: config.baseline.x1 ?? 0,
            x2: config.baseline.x2 ?? 0,
            y: config.baseline.y ?? 0,
          });
        }

        // Load text overlay configs (magazine + sticker/luggage card)
        if (config.name_text && typeof config.name_text === 'object' && Object.keys(config.name_text).length > 0) {
          setNameTextConfig({
            x: config.name_text.x ?? 100,
            y: config.name_text.y ?? 100,
            fontSize: config.name_text.fontSize ?? 60,
            color: config.name_text.color ?? '#FFFFFF',
            fontPath: config.name_text.fontPath ?? '',
            fontName: config.name_text.fontName ?? '',
            maxWidth: config.name_text.maxWidth ?? 0,
            align: config.name_text.align ?? 'left',
            uppercase: config.name_text.uppercase ?? false,
            rotation: config.name_text.rotation ?? 0,
            letterSpacing: config.name_text.letterSpacing ?? 0,
            strokeWidth: config.name_text.strokeWidth ?? 0,
            strokeColor: config.name_text.strokeColor ?? '#000000',
            shadowBlur: config.name_text.shadowBlur ?? 0,
            shadowColor: config.name_text.shadowColor ?? '#000000',
            shadowOffsetX: config.name_text.shadowOffsetX ?? 0,
            shadowOffsetY: config.name_text.shadowOffsetY ?? 0,
            opacity: config.name_text.opacity ?? 100,
          });
          setHasNameText(true);
        }
        if (config.designation_text && typeof config.designation_text === 'object' && Object.keys(config.designation_text).length > 0) {
          setDesignationTextConfig({
            x: config.designation_text.x ?? 100,
            y: config.designation_text.y ?? 180,
            fontSize: config.designation_text.fontSize ?? 40,
            color: config.designation_text.color ?? '#FFFFFF',
            fontPath: config.designation_text.fontPath ?? '',
            fontName: config.designation_text.fontName ?? '',
            maxWidth: config.designation_text.maxWidth ?? 0,
            align: config.designation_text.align ?? 'left',
            uppercase: config.designation_text.uppercase ?? false,
            rotation: config.designation_text.rotation ?? 0,
            letterSpacing: config.designation_text.letterSpacing ?? 0,
            strokeWidth: config.designation_text.strokeWidth ?? 0,
            strokeColor: config.designation_text.strokeColor ?? '#000000',
            shadowBlur: config.designation_text.shadowBlur ?? 0,
            shadowColor: config.designation_text.shadowColor ?? '#000000',
            shadowOffsetX: config.designation_text.shadowOffsetX ?? 0,
            shadowOffsetY: config.designation_text.shadowOffsetY ?? 0,
            opacity: config.designation_text.opacity ?? 100,
          });
          setHasDesignationText(true);
        }

        // Load luggage card settings
        if (typeof config.luggage_card_mode === 'boolean') setLuggageCardMode(config.luggage_card_mode);
        if (config.print_dpi === 300 || config.print_dpi === 600) setPrintDpi(config.print_dpi);
        if (config.print_width_mm) setPrintWidthMm(config.print_width_mm);
        if (config.print_height_mm) setPrintHeightMm(config.print_height_mm);
        if (config.output_format) setOutputFormat(config.output_format as 'png' | 'jpeg_print');

        // Convert slots from backend format to editor format
        if (config.slots && config.slots.length > 0) {
          const loadedSlots: SlotConfig[] = config.slots.map((slot: any, index: number) => {
            // Get anchor from slot config
            const anchorTargetX = slot.anchor?.targetX ?? slot.width / 2;
            const anchorTargetY = slot.anchor?.targetY ?? slot.height * 0.35;
            
            // Get slot-level settings or fall back to global
            const slotFaceRatio = slot.desiredFaceRatio ?? config.desiredFaceRatio ?? 0.25;
            const slotMinZoom = slot.minZoom ?? config.minZoom ?? 0.5;
            const slotMaxZoom = slot.maxZoom ?? config.maxZoom ?? 2.5;
            
            // Update global settings from first slot if present
            if (index === 0) {
              setDesiredFaceRatio(slotFaceRatio);
              setMinZoom(slotMinZoom);
              setMaxZoom(slotMaxZoom);
            }
            
            return {
              id: slot.slotId || slot.id || `slot${index + 1}`,
              x: slot.x,
              y: slot.y,
              width: slot.width,
              height: slot.height,
              // Convert absolute anchor to relative (0-1)
              anchorX: anchorTargetX / slot.width,
              anchorY: anchorTargetY / slot.height,
            };
          });
          setSlots(loadedSlots);
          
          // Select first slot
          if (loadedSlots.length > 0) {
            setSelectedSlotIndex(0);
            setMode('select');
          }
        }
        
        setConfigLoaded(true);
      } catch (err) {
        console.error('Error loading config:', err);
        setConfigLoaded(true);
      }
    }
    
    loadExistingConfig();
  }, [templateId]);

  // Sync canvas dimensions to print size when luggage card mode is on.
  // Without this, the template image's native dims override the saved print size
  // on initial load (race between image-load and config-load effects).
  useEffect(() => {
    if (!configLoaded) return;
    if (luggageCardMode) {
      const w = Math.round((printWidthMm / 25.4) * printDpi);
      const h = Math.round((printHeightMm / 25.4) * printDpi);
      setImageDimensions(prev => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    } else if (imageRef.current) {
      const w = imageRef.current.width;
      const h = imageRef.current.height;
      setImageDimensions(prev => (prev.width === w && prev.height === h ? prev : { width: w, height: h }));
    }
  }, [configLoaded, luggageCardMode, printWidthMm, printHeightMm, printDpi, imageLoaded]);

  // Load template image
  useEffect(() => {
    const img = new Image();
    // Don't set crossOrigin for same-origin requests (localhost)
    img.onload = () => {
      imageRef.current = img;
      setImageDimensions({ width: img.width, height: img.height });
      setImageLoaded(true);
      setImageError(null);
    };
    img.onerror = (e) => {
      console.error('Failed to load template image:', e);
      setImageError('Failed to load image. Please check the backend is running.');
    };
    img.src = imageUrl;
  }, [imageUrl]);

  // Calculate display scale to fit in container
  useEffect(() => {
    if (!containerRef.current || !imageLoaded) return;
    
    const container = containerRef.current;
    const maxWidth = container.clientWidth - 40; // Padding
    const maxHeight = window.innerHeight - 300; // Leave room for controls
    
    const scaleX = maxWidth / imageDimensions.width;
    const scaleY = maxHeight / imageDimensions.height;
    setScale(Math.min(scaleX, scaleY, 1)); // Don't scale up
  }, [imageLoaded, imageDimensions]);

  // Redraw canvas
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const img = imageRef.current;
    
    if (!canvas || !ctx || !img || !imageLoaded) return;

    // HiDPI-aware sizing: the backing store is rendered at device pixels (×dpr)
    // while CSS keeps the on-screen size, so the image isn't upscaled/blurred on
    // Retina/4K/Windows-scaled displays. All drawing below stays in CSS px because
    // we scale the context by dpr once here.
    const dpr = window.devicePixelRatio || 1;
    const cssW = imageDimensions.width * scale;
    const cssH = imageDimensions.height * scale;
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
    canvas.style.width = `${cssW}px`;
    canvas.style.height = `${cssH}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';

    // Clear and draw image (CSS-pixel coordinate space)
    ctx.clearRect(0, 0, cssW, cssH);
    ctx.drawImage(img, 0, 0, cssW, cssH);
    
    // Draw existing slots
    slots.forEach((slot, index) => {
      const isSelected = index === selectedSlotIndex;
      
      // Slot rectangle
      ctx.strokeStyle = isSelected ? '#00ff00' : '#ff6b6b';
      ctx.lineWidth = isSelected ? 3 : 2;
      ctx.setLineDash([5, 5]);
      ctx.strokeRect(
        slot.x * scale,
        slot.y * scale,
        slot.width * scale,
        slot.height * scale
      );
      ctx.setLineDash([]);
      
      // Fill with semi-transparent overlay
      ctx.fillStyle = isSelected ? 'rgba(0, 255, 0, 0.1)' : 'rgba(255, 107, 107, 0.1)';
      ctx.fillRect(
        slot.x * scale,
        slot.y * scale,
        slot.width * scale,
        slot.height * scale
      );
      
      // Anchor point (if set)
      const anchorScreenX = (slot.x + slot.width * slot.anchorX) * scale;
      const anchorScreenY = (slot.y + slot.height * slot.anchorY) * scale;
      
      ctx.beginPath();
      ctx.arc(anchorScreenX, anchorScreenY, 8, 0, Math.PI * 2);
      ctx.fillStyle = '#ffcc00';
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 2;
      ctx.stroke();
      
      // Crosshair at anchor
      ctx.strokeStyle = '#ffcc00';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(anchorScreenX - 12, anchorScreenY);
      ctx.lineTo(anchorScreenX + 12, anchorScreenY);
      ctx.moveTo(anchorScreenX, anchorScreenY - 12);
      ctx.lineTo(anchorScreenX, anchorScreenY + 12);
      ctx.stroke();
      
      // Slot label
      ctx.fillStyle = isSelected ? '#00ff00' : '#ff6b6b';
      ctx.font = 'bold 14px sans-serif';
      ctx.fillText(`Slot ${index + 1}`, slot.x * scale + 5, slot.y * scale + 18);
    });
    
    // Draw baseline segment (live draft takes precedence while dragging)
    const blToDraw = baselineDraft || baseline;
    if (blToDraw) {
      const x1 = blToDraw.x1 * scale;
      const x2 = blToDraw.x2 * scale;
      const y = blToDraw.y * scale;
      const lx = Math.min(x1, x2);
      const rx = Math.max(x1, x2);
      const midx = (x1 + x2) / 2;
      ctx.save();
      // the line
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 3;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(lx, y);
      ctx.lineTo(rx, y);
      ctx.stroke();
      // endpoint handles
      ctx.fillStyle = '#22d3ee';
      for (const ex of [lx, rx]) {
        ctx.beginPath();
        ctx.arc(ex, y, 6, 0, Math.PI * 2);
        ctx.fill();
      }
      // center tick (vertical)
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(midx, y - 14);
      ctx.lineTo(midx, y + 14);
      ctx.stroke();
      // width label
      const widthPx = Math.round(Math.abs(blToDraw.x2 - blToDraw.x1));
      const label = `baseline · width ${widthPx}px`;
      ctx.font = 'bold 13px sans-serif';
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(midx - tw / 2 - 5, y + 16, tw + 10, 20);
      ctx.fillStyle = '#22d3ee';
      ctx.fillText(label, midx - tw / 2, y + 30);
      ctx.restore();
    }

    // Draw FG overlay for magazine mode (semi-transparent so slots are still visible)
    if (fgImageRef && showFgOverlay && compositeMode === 'magazine') {
      const fgDrawW = (fgImageRef.naturalWidth || imageDimensions.width) * scale;
      const fgDrawH = (fgImageRef.naturalHeight || imageDimensions.height) * scale;
      ctx.globalAlpha = 0.6;
      ctx.drawImage(fgImageRef, fgOffset.x * scale, fgOffset.y * scale, fgDrawW, fgDrawH);
      ctx.globalAlpha = 1.0;
    }

    // Draw snap alignment guides (Instagram-style: bright magenta lines + label)
    if (activeGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#ff2d78';
      ctx.lineWidth = 1.5;
      ctx.shadowColor = 'rgba(255,45,120,0.7)';
      ctx.shadowBlur = 4;
      ctx.setLineDash([]);
      const glabel = Math.max(9, 10 * scale);
      for (const guide of activeGuides) {
        ctx.beginPath();
        if (guide.axis === 'x') {
          ctx.moveTo(guide.position * scale, 0);
          ctx.lineTo(guide.position * scale, cssH);
        } else {
          ctx.moveTo(0, guide.position * scale);
          ctx.lineTo(cssW, guide.position * scale);
        }
        ctx.stroke();
      }
      // Labels (no shadow, on chips) so it's obvious what you snapped to
      ctx.shadowBlur = 0;
      ctx.font = `600 ${glabel}px sans-serif`;
      ctx.textBaseline = 'top';
      for (const guide of activeGuides) {
        if (!guide.label) continue;
        const w = ctx.measureText(guide.label).width;
        let lx: number, ly: number;
        if (guide.axis === 'x') { lx = guide.position * scale + 4; ly = 4; }
        else { lx = 4; ly = guide.position * scale + 4; }
        ctx.fillStyle = 'rgba(255,45,120,0.92)';
        ctx.fillRect(lx - 2, ly - 1, w + 6, glabel + 4);
        ctx.fillStyle = '#fff';
        ctx.fillText(guide.label, lx + 1, ly + 1);
      }
      ctx.restore();
    }

    // Draw text overlays as true WYSIWYG boxes: the sample string is rendered in
    // the real font, size, colour, alignment and rotation the backend will use,
    // so the anchor is no longer guesswork. Placement math mirrors
    // compose.py::_draw_magazine_text exactly (align offset + rotation pivot).
    textHitRectsRef.current = { name: null, designation: null };
    if (hasNameText || hasDesignationText) {
      const drawTextBox = (
        key: 'name' | 'designation',
        cfg: TextConfig,
        sample: string,
        accent: string,
        isDragging: boolean,
      ) => {
        const raw = (sample && sample.trim()) ? sample : 'Sample';
        const text = cfg.uppercase ? raw.toUpperCase() : raw;
        const family = loadedFontNames.has(cfg.fontName) ? `"tpl-${cfg.fontName}"` : 'sans-serif';
        const anchorX = cfg.x * scale;
        const anchorY = cfg.y * scale;

        ctx.save();
        ctx.textBaseline = 'top';
        const spacingPx = (cfg.letterSpacing || 0) * scale;
        const setSpacing = (v: number) => { try { (ctx as unknown as { letterSpacing: string }).letterSpacing = `${v}px`; } catch { /* older browser */ } };

        // Fit width (screen px) — mirrors compose.py: maxWidth if set, else the
        // space from the anchor to the canvas edge based on alignment.
        const marginPx = 8 * scale;
        let fitW: number;
        if (cfg.maxWidth > 0) fitW = cfg.maxWidth * scale;
        else if (cfg.align === 'left') fitW = (imageDimensions.width - cfg.x) * scale - marginPx;
        else if (cfg.align === 'right') fitW = cfg.x * scale - marginPx;
        else fitW = 2 * Math.min(cfg.x, imageDimensions.width - cfg.x) * scale - marginPx;
        fitW = Math.max(fitW, 1);

        // Auto-shrink the font based on GLYPH width only (spacing off), so letter
        // spacing never collapses the font — matches compose.py.
        setSpacing(0);
        let fontPx = Math.max(2, cfg.fontSize * scale);
        const minFontPx = Math.max(8 * scale, fontPx * 0.4);
        ctx.font = `${fontPx}px ${family}`;
        const glyphW = ctx.measureText(text).width;
        if (glyphW > fitW && glyphW > 0) {
          fontPx = Math.max(minFontPx, fontPx * fitW / glyphW);
          ctx.font = `${fontPx}px ${family}`;
        }
        // Now apply spacing and measure the real drawn width (box + pivot).
        setSpacing(spacingPx);
        const textW = ctx.measureText(text).width;
        const boxH = fontPx * 1.18;               // approx line box (cosmetic)

        // Anchor-pivot for ALL alignments (rotated or not): the anchor is the
        // align edge — left→left edge, center→center, right→right edge.
        const localLeft = cfg.align === 'center' ? -textW / 2 : cfg.align === 'right' ? -textW : 0;

        // Max-width boundary guide (non-rotated), drawn around the fit region.
        if (cfg.maxWidth > 0 && cfg.rotation === 0) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,255,255,0.4)';
          ctx.setLineDash([2, 3]);
          ctx.lineWidth = 1;
          ctx.strokeRect(anchorX + localLeft, anchorY, fitW, boxH);
          ctx.restore();
        }

        ctx.translate(anchorX, anchorY);
        if (cfg.rotation !== 0) ctx.rotate(-cfg.rotation * Math.PI / 180); // canvas CW = PIL CCW

        // The text box outline
        ctx.setLineDash(isDragging ? [] : [5, 4]);
        ctx.strokeStyle = accent;
        ctx.lineWidth = isDragging ? 2.5 : 1.5;
        ctx.strokeRect(localLeft, 0, textW, boxH);
        ctx.setLineDash([]);
        // Faint fill so an empty/short box is still visible
        ctx.fillStyle = accent;
        ctx.globalAlpha = isDragging ? 0.16 : 0.08;
        ctx.fillRect(localLeft, 0, textW, boxH);
        ctx.globalAlpha = 1;

        // The sample text itself — with opacity, drop shadow and stroke outline
        ctx.save();
        ctx.globalAlpha = Math.max(0, Math.min(100, cfg.opacity ?? 100)) / 100;
        if ((cfg.shadowBlur ?? 0) > 0 || (cfg.shadowOffsetX ?? 0) !== 0 || (cfg.shadowOffsetY ?? 0) !== 0) {
          ctx.shadowColor = cfg.shadowColor || '#000000';
          ctx.shadowBlur = (cfg.shadowBlur || 0) * scale;
          ctx.shadowOffsetX = (cfg.shadowOffsetX || 0) * scale;
          ctx.shadowOffsetY = (cfg.shadowOffsetY || 0) * scale;
        }
        if ((cfg.strokeWidth ?? 0) > 0) {
          // Canvas centers the stroke; ×2 approximates PIL's outward stroke_width.
          ctx.lineWidth = (cfg.strokeWidth || 0) * 2 * scale;
          ctx.strokeStyle = cfg.strokeColor || '#000000';
          ctx.lineJoin = 'round';
          ctx.strokeText(text, localLeft, 0);
          // Don't let the fill cast a second shadow over the stroke
          ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0;
        }
        ctx.fillStyle = cfg.color;
        ctx.fillText(text, localLeft, 0);
        ctx.restore();

        // Compute the axis-aligned screen bbox of the (possibly rotated) box for hit-testing
        const corners = [
          [localLeft, 0], [localLeft + textW, 0],
          [localLeft, boxH], [localLeft + textW, boxH],
        ];
        const rad = cfg.rotation !== 0 ? -cfg.rotation * Math.PI / 180 : 0;
        const cos = Math.cos(rad), sin = Math.sin(rad);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const [lx, ly] of corners) {
          const sx = anchorX + lx * cos - ly * sin;
          const sy = anchorY + lx * sin + ly * cos;
          minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
          minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
        }
        ctx.restore();

        // Ensure a minimum grab area around the anchor so tiny text (e.g. a 60px
        // font on a 5000px canvas) is still visible and draggable.
        const MINHIT = 26;
        const hx = Math.min(minX, anchorX - MINHIT / 2);
        const hy = Math.min(minY, anchorY - MINHIT / 2);
        const hx1 = Math.max(maxX, anchorX + MINHIT / 2);
        const hy1 = Math.max(maxY, anchorY + MINHIT / 2);
        textHitRectsRef.current[key] = { x: hx, y: hy, w: hx1 - hx, h: hy1 - hy };
        const tinyOnScreen = (maxY - minY) < 12 || (maxX - minX) < 12;

        // Anchor handle + label chip in un-rotated screen space (always readable).
        ctx.save();
        // When the real text is too small to see, draw a fixed dashed affordance box
        // around the anchor so the operator can always find & grab it.
        if (tinyOnScreen) {
          ctx.strokeStyle = accent;
          ctx.setLineDash([4, 3]);
          ctx.lineWidth = 1.5;
          ctx.globalAlpha = 0.9;
          ctx.strokeRect(hx, hy, hx1 - hx, hy1 - hy);
          ctx.setLineDash([]);
          ctx.globalAlpha = 1;
        }
        ctx.beginPath();
        ctx.arc(anchorX, anchorY, isDragging ? 6 : 4.5, 0, Math.PI * 2);
        ctx.fillStyle = accent;
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const chipFont = Math.max(10, 11 * scale);
        ctx.font = `bold ${chipFont}px sans-serif`;
        const label = key === 'name' ? 'NAME ▸' : 'DESIG ▸';
        const chipW = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.roundRect(anchorX + 8, anchorY - chipFont - 6, chipW + 8, chipFont + 5, 3);
        ctx.fill();
        ctx.fillStyle = accent;
        ctx.fillText(label, anchorX + 12, anchorY - chipFont - 3);
        ctx.restore();
      };
      if (hasNameText) drawTextBox('name', nameTextConfig, namePreview, '#facc15', draggingText === 'name');
      if (hasDesignationText) drawTextBox('designation', designationTextConfig, designationPreview, '#4ade80', draggingText === 'designation');
    }

    // Ruler overlay for luggage card mode — a faint 10mm grid plus readable
    // numbered ticks on BOTH axes (the numbers are millimetres).
    if (luggageCardMode && imageDimensions.width > 0) {
      ctx.save();
      // Faint grid so it doesn't fight the artwork
      ctx.strokeStyle = 'rgba(120,190,255,0.16)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      for (let xmm = 10; xmm < printWidthMm; xmm += 10) {
        const xpx = (xmm / printWidthMm) * cssW;
        ctx.beginPath(); ctx.moveTo(xpx, 0); ctx.lineTo(xpx, cssH); ctx.stroke();
      }
      for (let ymm = 10; ymm < printHeightMm; ymm += 10) {
        const ypx = (ymm / printHeightMm) * cssH;
        ctx.beginPath(); ctx.moveTo(0, ypx); ctx.lineTo(cssW, ypx); ctx.stroke();
      }
      ctx.setLineDash([]);

      // Numbered ticks — bright, with a short solid tick at the edge
      const lblFont = Math.max(9, 10 * scale);
      ctx.font = `600 ${lblFont}px monospace`;
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.strokeStyle = 'rgba(150,205,255,0.85)';
      ctx.lineWidth = 1.5;
      const tick = Math.max(5, 6 * scale);
      const drawLabel = (txt: string, lx: number, ly: number) => {
        const w = ctx.measureText(txt).width;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(lx - 1, ly - 1, w + 3, lblFont + 2);
        ctx.fillStyle = 'rgba(190,225,255,0.98)';
        ctx.fillText(txt, lx, ly);
      };
      for (let xmm = 10; xmm < printWidthMm; xmm += 10) {
        const xpx = (xmm / printWidthMm) * cssW;
        ctx.beginPath(); ctx.moveTo(xpx, 0); ctx.lineTo(xpx, tick); ctx.stroke();
        drawLabel(`${xmm}`, xpx + 2, tick + 1);
      }
      for (let ymm = 10; ymm < printHeightMm; ymm += 10) {
        const ypx = (ymm / printHeightMm) * cssH;
        ctx.beginPath(); ctx.moveTo(0, ypx); ctx.lineTo(tick, ypx); ctx.stroke();
        drawLabel(`${ymm}`, tick + 2, ypx + 1);
      }
      // Unit badge at the origin so it's unambiguous what the numbers mean
      ctx.fillStyle = 'rgba(0,0,0,0.6)';
      ctx.fillRect(0, 0, ctx.measureText('mm').width + 8, lblFont + 4);
      ctx.fillStyle = 'rgba(190,225,255,0.98)';
      ctx.fillText('mm', 3, 2);
      ctx.restore();
    }

    // Draw current drawing rectangle
    if (isDrawing && mode === 'draw') {
      const x = Math.min(drawStart.x, drawCurrent.x);
      const y = Math.min(drawStart.y, drawCurrent.y);
      const w = Math.abs(drawCurrent.x - drawStart.x);
      const h = Math.abs(drawCurrent.y - drawStart.y);
      
      ctx.strokeStyle = '#00ccff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x, y, w, h);
      ctx.setLineDash([]);
    }
  }, [imageLoaded, imageDimensions, scale, slots, selectedSlotIndex, isDrawing, mode, drawStart, drawCurrent, fgImageRef, showFgOverlay, compositeMode, hasNameText, nameTextConfig, hasDesignationText, designationTextConfig, draggingText, fgOffset, activeGuides, luggageCardMode, printWidthMm, printHeightMm, baseline, baselineDraft, loadedFontNames, namePreview, designationPreview]);

  // Redraw on state changes
  useEffect(() => {
    redrawCanvas();
  }, [redrawCanvas]);

  // Get mouse position relative to canvas in image coordinates
  const getImageCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    
    const rect = canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;
    
    return {
      x: screenX / scale,
      y: screenY / scale,
    };
  };

  // Mouse position in canvas screen (device) pixels — used for text-box hit-testing.
  const getScreenCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  // Hit-test the drawn text boxes (whole box is grabbable, not a tiny dot).
  // sx, sy are screen-space canvas pixels. Anchor dot gets a small extra pad.
  const hitTestTextMarker = (sx: number, sy: number): 'name' | 'designation' | null => {
    const PAD = 6;
    const inRect = (r: { x: number; y: number; w: number; h: number } | null) =>
      !!r && sx >= r.x - PAD && sx <= r.x + r.w + PAD && sy >= r.y - PAD && sy <= r.y + r.h + PAD;
    if (hasNameText && inRect(textHitRectsRef.current.name)) return 'name';
    if (hasDesignationText && inRect(textHitRectsRef.current.designation)) return 'designation';
    return null;
  };

  // Snap a baseline to the template edges when an endpoint/line lands near one.
  // Lets "drag to the bottom" land flush on the last pixel (no gap under the subject).
  const snapBaselineToEdges = (b: Baseline): Baseline => {
    const W = imageDimensions.width, H = imageDimensions.height;
    const t = Math.max(8, Math.round(Math.min(W, H) * 0.02)); // ~2% of the short side
    const snap = (v: number, max: number) => (v < t ? 0 : Math.abs(v - max) < t ? max : v);
    return { x1: snap(b.x1, W), x2: snap(b.x2, W), y: snap(b.y, H) };
  };

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getImageCoords(e);

    // FG drag mode takes priority
    if (mode === 'fg' && compositeMode === 'magazine') {
      fgDragAnchorRef.current = { mouseX: coords.x, mouseY: coords.y, startX: fgOffset.x, startY: fgOffset.y };
      setIsDraggingFg(true);
      return;
    }

    // Baseline draw: mousedown sets one end + the locked Y, drag sets the other end
    if (mode === 'baseline') {
      isDrawingBaseline.current = true;
      setBaselineDraft(snapBaselineToEdges({ x1: Math.round(coords.x), x2: Math.round(coords.x), y: Math.round(coords.y) }));
      return;
    }

    // Check for text box drag (works whenever overlays are enabled)
    if (hasNameText || hasDesignationText) {
      const screen = getScreenCoords(e);
      const hit = hitTestTextMarker(screen.x, screen.y);
      if (hit) {
        // Preserve where inside the box the user grabbed, so the anchor doesn't jump.
        const cfg = hit === 'name' ? nameTextConfig : designationTextConfig;
        textDragOffsetRef.current = { dx: cfg.x - coords.x, dy: cfg.y - coords.y };
        setDraggingText(hit);
        return;
      }
    }

    if (mode === 'draw') {
      setIsDrawing(true);
      setDrawStart({ x: coords.x * scale, y: coords.y * scale });
      setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
    } else if (mode === 'anchor' && selectedSlotIndex !== null) {
      const slot = slots[selectedSlotIndex];
      if (
        coords.x >= slot.x && coords.x <= slot.x + slot.width &&
        coords.y >= slot.y && coords.y <= slot.y + slot.height
      ) {
        const anchorX = (coords.x - slot.x) / slot.width;
        const anchorY = (coords.y - slot.y) / slot.height;
        setSlots(prev => prev.map((s, i) =>
          i === selectedSlotIndex ? { ...s, anchorX, anchorY } : s
        ));
      }
    } else if (mode === 'select') {
      const clickedIndex = slots.findIndex(slot =>
        coords.x >= slot.x && coords.x <= slot.x + slot.width &&
        coords.y >= slot.y && coords.y <= slot.y + slot.height
      );
      setSelectedSlotIndex(clickedIndex >= 0 ? clickedIndex : null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getImageCoords(e);
    // Live position readout (clamped to the canvas for sane numbers)
    setHoverPos({
      x: Math.max(0, Math.min(imageDimensions.width, Math.round(coords.x))),
      y: Math.max(0, Math.min(imageDimensions.height, Math.round(coords.y))),
    });

    // Baseline draw: Y stays locked to the mousedown row (always horizontal)
    if (mode === 'baseline' && isDrawingBaseline.current) {
      setBaselineDraft(prev => prev ? snapBaselineToEdges({ ...prev, x2: Math.round(coords.x) }) : prev);
      return;
    }

    if (mode === 'fg' && fgDragAnchorRef.current) {
      const fgW = fgImageRef?.naturalWidth || imageDimensions.width;
      const fgH = fgImageRef?.naturalHeight || imageDimensions.height;
      const dx = coords.x - fgDragAnchorRef.current.mouseX;
      const dy = coords.y - fgDragAnchorRef.current.mouseY;
      const nx = fgDragAnchorRef.current.startX + dx;
      const ny = fgDragAnchorRef.current.startY + dy;
      if (snapEnabled) {
        const { snappedX, snappedY, guides } = computeSnap(nx, ny, fgW, fgH, imageDimensions.width, imageDimensions.height);
        setFgOffset({ x: Math.round(snappedX), y: Math.round(snappedY) });
        setActiveGuides(guides);
      } else {
        setFgOffset({ x: Math.round(nx), y: Math.round(ny) });
        setActiveGuides([]);
      }
      return;
    }

    if (draggingText) {
      // Apply the grab offset so the box stays under the cursor where it was grabbed.
      const rawX = Math.max(0, coords.x + textDragOffsetRef.current.dx);
      const rawY = Math.max(0, coords.y + textDragOffsetRef.current.dy);
      const cfg = draggingText === 'name' ? nameTextConfig : designationTextConfig;
      let finalX = rawX, finalY = rawY;
      const crossGuides: SnapGuide[] = [];
      if (snapEnabled) {
        const rect = textHitRectsRef.current[draggingText];
        if (rect && cfg.rotation === 0) {
          // Snap the whole box (left/center/right + top/mid/bottom) like IG.
          const w = rect.w / scale;
          const h = rect.h / scale;
          // anchor → box-left, depending on alignment
          const aOff = cfg.align === 'center' ? w / 2 : cfg.align === 'right' ? w : 0;
          const { snappedX, snappedY, guides } = computeSnap(
            rawX - aOff, rawY, w, h, imageDimensions.width, imageDimensions.height,
          );
          finalX = snappedX + aOff;
          finalY = snappedY;
          crossGuides.push(...guides);
        } else {
          // Rotated text: snap the anchor point only.
          const { snappedX, snappedY, guides } = computeSnap(
            rawX, rawY, 1, 1, imageDimensions.width, imageDimensions.height,
          );
          finalX = snappedX; finalY = snappedY;
          crossGuides.push(...guides);
        }
        // Also snap to the OTHER text marker's anchor (align both texts)
        const otherCfg = draggingText === 'name' ? designationTextConfig : nameTextConfig;
        const otherEnabled = draggingText === 'name' ? hasDesignationText : hasNameText;
        if (otherEnabled) {
          if (Math.abs(finalX - otherCfg.x) < 12) { finalX = otherCfg.x; crossGuides.push({ axis: 'x', position: otherCfg.x, label: 'align' }); }
          if (Math.abs(finalY - otherCfg.y) < 12) { finalY = otherCfg.y; crossGuides.push({ axis: 'y', position: otherCfg.y, label: 'align' }); }
        }
      }
      setActiveGuides(crossGuides);
      const nx = Math.round(finalX);
      const ny = Math.round(finalY);
      if (draggingText === 'name') setNameTextConfig(p => ({ ...p, x: nx, y: ny }));
      else setDesignationTextConfig(p => ({ ...p, x: nx, y: ny }));
      return;
    }

    if (isDrawing && mode === 'draw') {
      setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
    }
  };

  const handleMouseUp = () => {
    // Baseline draw: commit if the segment is long enough, else discard
    if (mode === 'baseline' && isDrawingBaseline.current) {
      isDrawingBaseline.current = false;
      setBaselineDraft(draft => {
        if (draft && Math.abs(draft.x2 - draft.x1) > 20) {
          const lo = Math.min(draft.x1, draft.x2);
          const hi = Math.max(draft.x1, draft.x2);
          setBaseline(snapBaselineToEdges({ x1: lo, x2: hi, y: draft.y }));
          // Drawing a baseline IS the intent to use baseline placement — the
          // backend only honours the baseline when anchorMode === 'baseline'
          // (compose.py). Flip it here so the setting can't silently disagree.
          setAnchorMode('baseline');
        }
        return null;
      });
      return;
    }

    if (mode === 'fg' && fgDragAnchorRef.current) {
      fgDragAnchorRef.current = null;
      setIsDraggingFg(false);
      setActiveGuides([]);
      return;
    }

    if (draggingText) {
      setDraggingText(null);
      setActiveGuides([]);
      return;
    }

    if (isDrawing && mode === 'draw') {
      const x = Math.min(drawStart.x, drawCurrent.x) / scale;
      const y = Math.min(drawStart.y, drawCurrent.y) / scale;
      const width = Math.abs(drawCurrent.x - drawStart.x) / scale;
      const height = Math.abs(drawCurrent.y - drawStart.y) / scale;

      if (width > 50 && height > 50) {
        const newSlot: SlotConfig = {
          id: `slot${slots.length + 1}`,
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
          anchorX: 0.5,
          anchorY: 0.35,
        };
        setSlots(prev => [...prev, newSlot]);
        setSelectedSlotIndex(slots.length);
        setMode('anchor');
      }

      setIsDrawing(false);
    }
  };

  // Delete selected slot
  const handleDeleteSlot = () => {
    if (selectedSlotIndex !== null) {
      setSlots(prev => prev.filter((_, i) => i !== selectedSlotIndex));
      setSelectedSlotIndex(null);
    }
  };

  // Clear all slots
  const handleClearAll = () => {
    if (confirm('Clear all slots?')) {
      setSlots([]);
      setSelectedSlotIndex(null);
    }
  };

  // Upload a .ttf/.otf font, refresh the font list, and hand back the new name.
  const handleFontUpload = useCallback(async (fileList: FileList | null, onDone: (name: string) => void) => {
    const file = fileList?.[0];
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (!lower.endsWith('.ttf') && !lower.endsWith('.otf')) {
      alert('Please choose a .ttf or .otf font file.');
      return;
    }
    setUploadingFont(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await fetch(`${API_BASE_URL}/api/admin/fonts`, { method: 'POST', body: fd });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.detail || 'Upload failed');
      }
      const data = await res.json();
      // Refresh the font list (the load effect will register the new FontFace).
      const listData = await fetch(`${API_BASE_URL}/api/admin/fonts`).then(r => r.json()).catch(() => null);
      if (listData) setFonts(listData.fonts ?? []);
      onDone(data.name);
    } catch (e) {
      alert(`Font upload failed: ${e instanceof Error ? e.message : 'unknown error'}`);
    } finally {
      setUploadingFont(false);
    }
  }, []);

  // Save configuration
  const handleSave = () => {
    // Sticker templates place the subject via a slot OR a baseline. Only block the
    // save when neither exists (the backend auto-synthesises a full-canvas slot,
    // so a baseline alone is a perfectly valid, common setup).
    if (templateType === 'sticker' && slots.length === 0 && !baseline) {
      alert('Draw a Slot, or a Baseline, so the photo has somewhere to go.');
      return;
    }

    const config: TemplateConfig = {
      templateId,
      name: templateName,
      templateType,
      compositeMode,
      stickerFilter,
      pngUrl: imageUrl.split('/').pop() || '',
      anchorMode,
      dimensions: imageDimensions,
      slots: slots.map(slot => ({
        ...slot,
        anchorX: slot.anchorX,
        anchorY: slot.anchorY,
      })),
      desiredFaceRatio,
      minZoom,
      maxZoom,
      showVisualGuide,
      allowManualPositioning,
      baseline: baseline ?? null,
      fg_offset: fgOffset,
      name_text: hasNameText ? nameTextConfig : undefined,
      designation_text: hasDesignationText ? designationTextConfig : undefined,
      luggage_card_mode: luggageCardMode,
      print_dpi: printDpi,
      print_width_mm: printWidthMm,
      print_height_mm: printHeightMm,
      output_format: outputFormat,
    };

    onSave(config);
  };

  return (
    <div className={styles.editorContainer}>
      <div className={styles.header}>
        <h2 className={styles.title}>Configure: {templateName}</h2>
        <div className={styles.headerActions}>
          <button className={styles.cancelButton} onClick={onCancel}>
            Cancel
          </button>
          <button className={styles.saveButton} onClick={handleSave}>
            💾 Save Configuration
          </button>
        </div>
      </div>

      <div className={styles.editorBody}>
        {/* Toolbar */}
        <div className={styles.toolbar}>
          <div className={styles.toolGroup}>
            <span className={styles.toolLabel}>Mode:</span>
            <button 
              className={`${styles.toolButton} ${mode === 'select' ? styles.active : ''}`}
              onClick={() => setMode('select')}
              title="Select slot"
            >
              👆 Select
            </button>
            <button 
              className={`${styles.toolButton} ${mode === 'draw' ? styles.active : ''}`}
              onClick={() => setMode('draw')}
              title="Draw new slot"
            >
              ✏️ Draw Slot
            </button>
            <button
              className={`${styles.toolButton} ${mode === 'anchor' ? styles.active : ''}`}
              onClick={() => setMode('anchor')}
              disabled={selectedSlotIndex === null}
              title="Set anchor point"
            >
              🎯 Set Anchor
            </button>
            <button
              className={`${styles.toolButton} ${mode === 'baseline' ? styles.active : ''}`}
              onClick={() => setMode('baseline')}
              title="Draw the baseline: the subject's bottom sits on this line, centered on its midpoint, scaled to its length"
            >
              📏 Draw Baseline
            </button>
            {baseline && (
              <button
                className={styles.toolButton}
                onClick={() => { setBaseline(null); if (anchorMode === 'baseline') setAnchorMode('none'); }}
                title="Remove the baseline"
              >
                ✕ Clear Baseline
              </button>
            )}
          </div>
          
          {compositeMode === 'magazine' && (
            <div className={styles.toolGroup}>
              <button
                className={`${styles.toolButton} ${showFgOverlay ? styles.active : ''}`}
                onClick={() => setShowFgOverlay(v => !v)}
                title="Toggle foreground overlay visibility"
              >
                {showFgOverlay ? '🪟 FG: ON' : '🪟 FG: OFF'}
              </button>
              <button
                className={`${styles.toolButton} ${mode === 'fg' ? styles.active : ''}`}
                onClick={() => setMode('fg')}
                title="Drag FG overlay to reposition — smart guides snap to center, edges, and thirds"
              >
                📐 Move FG
              </button>
              <button
                className={styles.toolButton}
                onClick={() => setFgOffset({ x: 0, y: 0 })}
                title="Reset FG position to origin (0, 0)"
              >
                ↺ Reset FG
              </button>
            </div>
          )}

          <div className={styles.toolGroup}>
            <button
              className={`${styles.toolButton} ${snapEnabled ? styles.active : ''}`}
              onClick={() => setSnapEnabled(v => !v)}
              title="Magnet snapping to edges, center and thirds. Turn off to place exactly where you drop."
            >
              {snapEnabled ? '🧲 Snap: ON' : '🧲 Snap: OFF'}
            </button>
          </div>

          <div className={styles.toolGroup}>
            <button
              className={styles.dangerButton}
              onClick={handleDeleteSlot}
              disabled={selectedSlotIndex === null}
            >
              🗑️ Delete Slot
            </button>
            <button
              className={styles.dangerButton}
              onClick={handleClearAll}
              disabled={slots.length === 0}
            >
              Clear All
            </button>
          </div>
        </div>

        {/* Canvas area */}
        <div className={styles.canvasContainer} ref={containerRef}>
          {(!imageLoaded || !configLoaded) && !imageError && (
            <div className={styles.loadingOverlay}>
              {!configLoaded ? 'Loading configuration...' : 'Loading template...'}
            </div>
          )}
          {imageError && (
            <div className={styles.loadingOverlay} style={{ color: '#ff6b6b' }}>
              {imageError}
            </div>
          )}
          <canvas
            ref={canvasRef}
            className={styles.canvas}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
            onMouseLeave={() => { handleMouseUp(); setHoverPos(null); }}
            style={{ cursor: draggingText ? 'grabbing' : mode === 'fg' ? (isDraggingFg ? 'grabbing' : 'grab') : mode === 'draw' || mode === 'baseline' ? 'crosshair' : mode === 'anchor' ? 'pointer' : 'default' }}
          />

          {/* Live position readout — tells you exactly what coordinates you're at */}
          {hoverPos && imageLoaded && (
            <div
              style={{
                position: 'absolute', top: 8, right: 8, zIndex: 5,
                background: 'rgba(0,0,0,0.72)', color: '#e5e7eb',
                font: '600 12px/1.4 monospace', padding: '5px 9px', borderRadius: 6,
                pointerEvents: 'none', letterSpacing: '0.02em',
              }}
            >
              <div>x {hoverPos.x} · y {hoverPos.y} px</div>
              {luggageCardMode && imageDimensions.width > 0 && (
                <div style={{ color: '#7dd3fc' }}>
                  {(hoverPos.x * printWidthMm / imageDimensions.width).toFixed(1)} ·{' '}
                  {(hoverPos.y * printHeightMm / imageDimensions.height).toFixed(1)} mm
                </div>
              )}
            </div>
          )}

          {/* Instructions overlay */}
          <div className={styles.instructions}>
            {mode === 'draw' && '🖱️ Drag to draw a slot rectangle'}
            {mode === 'anchor' && selectedSlotIndex !== null && '🎯 Click inside the slot to set face anchor point'}
            {mode === 'select' && '👆 Click on a slot to select it'}
            {mode === 'baseline' && '📏 Drag a horizontal line where the subject should stand — bottom sits on it, width = its length. Snaps flush to template edges.'}
            {mode === 'fg' && `📐 Drag to reposition FG overlay — cyan guides snap to center, edges & thirds  (offset: ${fgOffset.x}, ${fgOffset.y})`}
          </div>
        </div>

        {/* Settings panel */}
        <div className={styles.settingsPanel}>
          <h3 className={styles.settingsTitle}>Template Settings</h3>
          
          {/* Luggage Card Printing Mode */}
          <div className={styles.settingRow} style={{ background: 'rgba(251,191,36,0.08)', borderRadius: 8, padding: '10px 12px', marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontWeight: 600 }}>
              <input
                type="checkbox"
                checked={luggageCardMode}
                onChange={e => {
                  const on = e.target.checked;
                  setLuggageCardMode(on);
                  if (on) {
                    // Force composite mode to background and lock dimensions to print size
                    setCompositeMode('background');
                    setTemplateType('sticker');
                    const w = Math.round(printWidthMm / 25.4 * printDpi);
                    const h = Math.round(printHeightMm / 25.4 * printDpi);
                    setImageDimensions({ width: w, height: h });
                  }
                }}
                style={{ width: 16, height: 16 }}
              />
              🪪 Luggage Card Printing Mode
            </label>
            {luggageCardMode && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <div className={styles.settingRow}>
                  <label>Card size (mm):</label>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <input type="number" value={printWidthMm} step="0.1"
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 86;
                        setPrintWidthMm(v);
                        setImageDimensions(prev => ({ ...prev, width: Math.round(v / 25.4 * printDpi) }));
                      }}
                      style={{ width: 56 }} />
                    <span>×</span>
                    <input type="number" value={printHeightMm} step="0.1"
                      onChange={e => {
                        const v = parseFloat(e.target.value) || 54;
                        setPrintHeightMm(v);
                        setImageDimensions(prev => ({ ...prev, height: Math.round(v / 25.4 * printDpi) }));
                      }}
                      style={{ width: 56 }} />
                    <span>mm</span>
                    <button className={styles.toolButton} style={{ fontSize: '0.75rem' }}
                      onClick={() => { setPrintWidthMm(86); setPrintHeightMm(54); setImageDimensions({ width: Math.round(86 / 25.4 * printDpi), height: Math.round(54 / 25.4 * printDpi) }); }}>
                      CR80
                    </button>
                    <button className={styles.toolButton} style={{ fontSize: '1rem', padding: '2px 6px' }}
                      title="Swap portrait / landscape"
                      onClick={() => {
                        const newW = printHeightMm;
                        const newH = printWidthMm;
                        setPrintWidthMm(newW);
                        setPrintHeightMm(newH);
                        setImageDimensions({
                          width: Math.round(newW / 25.4 * printDpi),
                          height: Math.round(newH / 25.4 * printDpi),
                        });
                      }}>
                      ↻
                    </button>
                  </div>
                </div>
                <div className={styles.settingRow}>
                  <label>DPI:</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {([300, 600] as const).map(d => (
                      <label key={d} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                        <input type="radio" name="printDpi" value={d} checked={printDpi === d}
                          onChange={() => {
                            const factor = d / printDpi;
                            setPrintDpi(d);
                            const newW = Math.round(printWidthMm / 25.4 * d);
                            const newH = Math.round(printHeightMm / 25.4 * d);
                            setImageDimensions({ width: newW, height: newH });
                            // Scale all overlay positions
                            setNameTextConfig(p => ({ ...p, x: Math.round(p.x * factor), y: Math.round(p.y * factor), fontSize: Math.round(p.fontSize * factor), maxWidth: p.maxWidth ? Math.round(p.maxWidth * factor) : 0 }));
                            setDesignationTextConfig(p => ({ ...p, x: Math.round(p.x * factor), y: Math.round(p.y * factor), fontSize: Math.round(p.fontSize * factor), maxWidth: p.maxWidth ? Math.round(p.maxWidth * factor) : 0 }));
                            setSlots(prev => prev.map(s => ({ ...s, x: Math.round(s.x * factor), y: Math.round(s.y * factor), width: Math.round(s.width * factor), height: Math.round(s.height * factor) })));
                          }} />
                        {d} DPI
                      </label>
                    ))}
                  </div>
                </div>
                <div className={styles.settingRow}>
                  <label>Canvas (locked):</label>
                  <span style={{ fontFamily: 'monospace', color: '#a3e635' }}>
                    {imageDimensions.width} × {imageDimensions.height} px
                  </span>
                </div>
                <div className={styles.settingRow}>
                  <label>Output format:</label>
                  <div style={{ display: 'flex', gap: 12 }}>
                    {(['png', 'jpeg_print'] as const).map(f => (
                      <label key={f} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                        <input type="radio" name="outputFormat" value={f} checked={outputFormat === f} onChange={() => setOutputFormat(f)} />
                        {f === 'png' ? 'PNG (lossless)' : 'JPEG q95'}
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className={styles.settingRow}>
            <label>Template Type:</label>
            <select value={templateType} onChange={e => setTemplateType(e.target.value as typeof templateType)}>
              <option value="sticker">Sticker (Remove BG)</option>
              <option value="frame">Frame (Keep Photo)</option>
              <option value="magazine">Magazine (BG + User + FG)</option>
            </select>
          </div>

          <div className={styles.settingRow}>
            <label>Composite Mode:</label>
            <select value={compositeMode} onChange={e => setCompositeMode(e.target.value as typeof compositeMode)}>
              <option value="background">Background (template behind sticker)</option>
              <option value="overlay">Overlay (template over photo)</option>
              <option value="magazine">Magazine (BG → User → FG sandwich)</option>
            </select>
          </div>

          {/* Guardrail: overlay only works when the PNG has a transparent photo window.
              A solid card in overlay mode covers the photo entirely. */}
          {compositeMode === 'overlay' && pngTransparentPct !== null && pngTransparentPct < 1 && (
            <div className={styles.settingRow} style={{ background: 'rgba(239,68,68,0.12)', border: '1px solid rgba(239,68,68,0.5)', borderRadius: 6, padding: '8px 10px' }}>
              <span style={{ fontSize: '0.78rem', color: '#fca5a5' }}>
                ⚠️ This template is a <strong>solid image</strong> (no transparent photo window),
                so <strong>Overlay</strong> mode will cover the photo completely and hide the person.
                Switch to <strong>Background (template behind sticker)</strong> and use
                <strong> Sticker (Remove BG)</strong> type so the person is placed on top.
              </span>
            </div>
          )}
          {templateType === 'sticker' && slots.length === 0 && !baseline && (
            <div className={styles.settingRow} style={{ background: 'rgba(251,191,36,0.1)', border: '1px solid rgba(251,191,36,0.4)', borderRadius: 6, padding: '8px 10px' }}>
              <span style={{ fontSize: '0.78rem', color: '#fcd34d' }}>
                ℹ️ No slot or baseline defined. The person will be auto-placed full-canvas
                (bottom-centered). Draw a <strong>Baseline</strong> for precise grounding, or a
                <strong> Slot</strong> to confine the photo area.
              </span>
            </div>
          )}

          {compositeMode === 'magazine' && (
            <div className={styles.settingRow} style={{ background: 'rgba(99,102,241,0.1)', borderRadius: 6, padding: '8px 10px' }}>
              <span style={{ fontSize: '0.78rem', color: '#a5b4fc' }}>
                📰 Magazine mode: the BG image goes behind the user. Upload the FG overlay via the Magazine tab after saving.
              </span>
            </div>
          )}

          {/* Text Overlays — available for all template types */}
          <h3 className={styles.settingsTitle} style={{ marginTop: '1rem' }}>Text Overlays</h3>
          <p className={styles.hint} style={{ marginBottom: 8 }}>
            The dashed box shows the real text — font, size, colour, alignment & rotation.
            Drag the box to position it; the round handle is the anchor point.
          </p>

          {/* Helper to render one text overlay section */}
          {(() => {
            const renderOverlay = (
              label: string,
              accentColor: string,
              enabled: boolean,
              setEnabled: (v: boolean) => void,
              cfg: TextConfig,
              setCfg: (v: TextConfig) => void,
              preview: string,
              setPreview: (v: string) => void,
            ) => (
              <div style={{ marginBottom: 8 }}>
                <div className={styles.settingRow}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={enabled} onChange={e => {
                      const on = e.target.checked;
                      setEnabled(on);
                      // Give a visible default size on big canvases (60px is invisible on a 5000px card)
                      if (on && cfg.fontSize === 60 && imageDimensions.height > 1500) {
                        setCfg({ ...cfg, fontSize: Math.round(imageDimensions.height * 0.045) });
                      }
                    }} style={{ width: 16, height: 16 }} />
                    <strong style={{ color: accentColor }}>{label}</strong>
                  </label>
                </div>
                {enabled && (
                  <div style={{ paddingLeft: 12, borderLeft: `2px solid ${accentColor}`, marginBottom: 8 }}>
                    <div className={styles.settingRow}>
                      <label>Preview text (sample only):</label>
                      <input type="text" value={preview} onChange={e => setPreview(e.target.value)} placeholder="Sample name" style={{ width: '100%' }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Anchor (X, Y) — drag the box on canvas:</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="number" value={cfg.x} onChange={e => setCfg({ ...cfg, x: +e.target.value })} style={{ width: 70 }} />
                        <input type="number" value={cfg.y} onChange={e => setCfg({ ...cfg, y: +e.target.value })} style={{ width: 70 }} />
                      </div>
                    </div>
                    <p className={styles.hint} style={{ margin: '0 0 6px' }}>
                      {cfg.align === 'left'
                        ? 'X, Y = where the first letter starts (top-left).'
                        : cfg.align === 'center'
                        ? 'Text is centered in the width from X rightwards; Y = top.'
                        : 'Text is right-aligned within the width from X; Y = top.'}
                    </p>
                    <div className={styles.settingRow}>
                      <label>Rotation (°):</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="range" min={-180} max={180} step={1} value={cfg.rotation}
                          onChange={e => setCfg({ ...cfg, rotation: +e.target.value })} style={{ width: 120 }} />
                        <input type="number" value={cfg.rotation} min={-180} max={180}
                          onChange={e => setCfg({ ...cfg, rotation: Math.max(-180, Math.min(180, +e.target.value)) })} style={{ width: 60 }} />
                        <span>°</span>
                        {cfg.rotation !== 0 && (
                          <button onClick={() => setCfg({ ...cfg, rotation: 0 })} style={{ fontSize: '0.7rem', padding: '2px 6px' }}>Reset</button>
                        )}
                      </div>
                    </div>
                    <div className={styles.settingRow}>
                      <label>Font Size:</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="number" value={cfg.fontSize} onChange={e => setCfg({ ...cfg, fontSize: +e.target.value })} style={{ width: 70 }} />
                        <span>px</span>
                        <button
                          type="button"
                          onClick={() => setCfg({ ...cfg, fontSize: Math.max(12, Math.round(imageDimensions.height * 0.045)) })}
                          title="Set a sensible size (~4.5% of card height) for this template's resolution"
                          style={{ fontSize: '0.72rem', padding: '3px 8px' }}
                        >
                          Auto size
                        </button>
                      </div>
                    </div>
                    <p className={styles.hint} style={{ margin: '0 0 6px' }}>
                      ≈ {imageDimensions.height ? (cfg.fontSize / imageDimensions.height * 100).toFixed(1) : '—'}% of card height
                      {' · '}canvas {imageDimensions.width}×{imageDimensions.height}px
                      {imageDimensions.height > 0 && cfg.fontSize / imageDimensions.height < 0.015 && (
                        <span style={{ color: '#fca5a5' }}> — likely too small to see; try “Auto size”.</span>
                      )}
                    </p>
                    <div className={styles.settingRow}>
                      <label>Color:</label>
                      <input type="color" value={cfg.color} onChange={e => setCfg({ ...cfg, color: e.target.value })} />
                      <input type="text" value={cfg.color} onChange={e => setCfg({ ...cfg, color: e.target.value })} style={{ width: 80 }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Font:</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <select value={cfg.fontName} onChange={e => setCfg({ ...cfg, fontName: e.target.value, fontPath: '' })}>
                          <option value="">Default</option>
                          {fonts.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                        </select>
                        <label
                          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, cursor: uploadingFont ? 'wait' : 'pointer', fontSize: '0.75rem', padding: '4px 8px', border: `1px solid ${accentColor}`, borderRadius: 4, color: accentColor, whiteSpace: 'nowrap' }}
                          title="Upload a .ttf or .otf font"
                        >
                          {uploadingFont ? '⏳ Uploading…' : '⬆ Upload font'}
                          <input
                            type="file"
                            accept=".ttf,.otf,font/ttf,font/otf"
                            disabled={uploadingFont}
                            style={{ display: 'none' }}
                            onChange={e => {
                              handleFontUpload(e.target.files, (name) => setCfg({ ...cfg, fontName: name, fontPath: '' }));
                              e.target.value = '';
                            }}
                          />
                        </label>
                      </div>
                    </div>
                    {!cfg.fontName && (
                      <div className={styles.settingRow}>
                        <label>Font Path (advanced):</label>
                        <input type="text" value={cfg.fontPath} onChange={e => setCfg({ ...cfg, fontPath: e.target.value })} placeholder="/app/fonts/MyFont.ttf" style={{ width: '100%' }} />
                      </div>
                    )}
                    <div className={styles.settingRow}>
                      <label>Max Width (0=none):</label>
                      <input type="number" value={cfg.maxWidth} onChange={e => setCfg({ ...cfg, maxWidth: +e.target.value })} style={{ width: 80 }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Align:</label>
                      <select value={cfg.align} onChange={e => setCfg({ ...cfg, align: e.target.value as 'left' | 'center' | 'right' })}>
                        <option value="left">Left</option>
                        <option value="center">Center</option>
                        <option value="right">Right</option>
                      </select>
                    </div>
                    <div className={styles.settingRow}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                        <input type="checkbox" checked={cfg.uppercase} onChange={e => setCfg({ ...cfg, uppercase: e.target.checked })} />
                        Uppercase
                      </label>
                    </div>
                    <div className={styles.settingRow}>
                      <label>Letter Spacing:</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                        <input type="range" min={-10} max={40} step={0.5} value={cfg.letterSpacing}
                          onChange={e => setCfg({ ...cfg, letterSpacing: +e.target.value })} style={{ width: 110 }} />
                        <input type="number" value={cfg.letterSpacing} step={0.5}
                          onChange={e => setCfg({ ...cfg, letterSpacing: +e.target.value })} style={{ width: 56 }} />
                        <span>px</span>
                      </div>
                    </div>
                    <div className={styles.settingRow}>
                      <label>Opacity: {cfg.opacity}%</label>
                      <input type="range" min={0} max={100} step={1} value={cfg.opacity}
                        onChange={e => setCfg({ ...cfg, opacity: +e.target.value })} style={{ width: 140 }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Outline (width / color):</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input type="number" min={0} value={cfg.strokeWidth} title="Outline width in px (0 = off)"
                          onChange={e => setCfg({ ...cfg, strokeWidth: Math.max(0, +e.target.value) })} style={{ width: 56 }} />
                        <span>px</span>
                        <input type="color" value={cfg.strokeColor} onChange={e => setCfg({ ...cfg, strokeColor: e.target.value })} />
                      </div>
                    </div>
                    <div className={styles.settingRow}>
                      <label>Shadow (blur / X / Y / color):</label>
                      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                        <input type="number" min={0} value={cfg.shadowBlur} title="Blur radius in px (0 = off)"
                          onChange={e => setCfg({ ...cfg, shadowBlur: Math.max(0, +e.target.value) })} style={{ width: 46 }} />
                        <input type="number" value={cfg.shadowOffsetX} title="Horizontal offset"
                          onChange={e => setCfg({ ...cfg, shadowOffsetX: +e.target.value })} style={{ width: 46 }} />
                        <input type="number" value={cfg.shadowOffsetY} title="Vertical offset"
                          onChange={e => setCfg({ ...cfg, shadowOffsetY: +e.target.value })} style={{ width: 46 }} />
                        <input type="color" value={cfg.shadowColor} onChange={e => setCfg({ ...cfg, shadowColor: e.target.value })} />
                      </div>
                    </div>
                  </div>
                )}
              </div>
            );
            return (
              <>
                {renderOverlay('Name Text', '#facc15', hasNameText, setHasNameText, nameTextConfig, setNameTextConfig, namePreview, setNamePreview)}
                {renderOverlay('Designation Text', '#4ade80', hasDesignationText, setHasDesignationText, designationTextConfig, setDesignationTextConfig, designationPreview, setDesignationPreview)}
              </>
            );
          })()}
          
          <div className={styles.settingRow}>
            <label>Image Filter:</label>
            <select value={stickerFilter} onChange={e => setStickerFilter(e.target.value as typeof stickerFilter)}>
              <option value="none">None (Original Colors)</option>
              <option value="bw">Black & White (High Contrast)</option>
              <option value="sketch">Pencil Sketch</option>
            </select>
          </div>
          
          <div className={styles.settingRow}>
            <label>Anchor Mode:</label>
            <select value={anchorMode} onChange={e => setAnchorMode(e.target.value as typeof anchorMode)}>
              <option value="baseline">Baseline (Robust auto-place) ⭐</option>
              <option value="face_center">Face Center</option>
              <option value="eyes">Eyes</option>
              <option value="full_frame">Full Frame (1:1 UI Overlay)</option>
              <option value="none">None (Bottom anchor)</option>
            </select>
          </div>

          {anchorMode === 'baseline' && (
            <div className={styles.settingRow} style={{ background: 'rgba(34,211,238,0.1)', borderRadius: 6, padding: '8px 10px' }}>
              <span style={{ fontSize: '0.78rem', color: '#67e8f9' }}>
                📏 Robust placement: the cutout is auto-scaled & grounded on the baseline (no face detection).
                {baseline
                  ? ` Baseline set: width ${Math.abs(baseline.x2 - baseline.x1)}px at y=${baseline.y}. Use “Draw Baseline” to redraw.`
                  : ' Click “Draw Baseline” above, then drag a horizontal line where the subject should stand.'}
              </span>
            </div>
          )}
          
          <div className={styles.settingRow} style={{ alignItems: 'center', marginTop: '1rem', marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '8px' }}>
              <input 
                type="checkbox" 
                checked={showVisualGuide} 
                onChange={e => setShowVisualGuide(e.target.checked)} 
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              Show Live Visual Guide to Users
            </label>
            <p className={styles.hint} style={{ margin: '4px 0 0 26px' }}>
              If enabled, users will see the template image overlaid on the webcam to help them align. Best used with "Full Frame" anchor mode.
            </p>
          </div>

          <div className={styles.settingRow} style={{ alignItems: 'center', marginBottom: '1rem' }}>
            <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer', gap: '8px' }}>
              <input 
                type="checkbox" 
                checked={allowManualPositioning} 
                onChange={e => setAllowManualPositioning(e.target.checked)} 
                style={{ width: '18px', height: '18px', cursor: 'pointer' }}
              />
              Enable Interactive Repositioning
            </label>
            <p className={styles.hint} style={{ margin: '4px 0 0 26px' }}>
              If enabled, users will get a new step after capture allowing them to manually drag and resize their photo over the template. Best used for Doodle.
            </p>
          </div>
          
          <div className={styles.settingRow}>
            <label>Face Size Ratio: {(desiredFaceRatio * 100).toFixed(0)}%</label>
            <input 
              type="range" 
              min="0.15" 
              max="0.5" 
              step="0.05"
              value={desiredFaceRatio}
              onChange={e => setDesiredFaceRatio(parseFloat(e.target.value))}
            />
            <span className={styles.hint}>How much of slot height the face should occupy</span>
          </div>
          
          <div className={styles.settingRow}>
            <label>Zoom Range:</label>
            <div className={styles.rangeInputs}>
              <input 
                type="number" 
                value={minZoom} 
                onChange={e => setMinZoom(parseFloat(e.target.value))}
                step="0.1"
                min="0.1"
                max="1"
              />
              <span>to</span>
              <input 
                type="number" 
                value={maxZoom} 
                onChange={e => setMaxZoom(parseFloat(e.target.value))}
                step="0.1"
                min="1"
                max="5"
              />
            </div>
          </div>

          {/* Slot list */}
          <h3 className={styles.settingsTitle}>Slots ({slots.length})</h3>
          <div className={styles.slotList}>
            {slots.map((slot, index) => (
              <div 
                key={slot.id}
                className={`${styles.slotItem} ${index === selectedSlotIndex ? styles.selected : ''}`}
                onClick={() => setSelectedSlotIndex(index)}
              >
                <strong>Slot {index + 1}</strong>
                <span>
                  {slot.width}×{slot.height} at ({slot.x}, {slot.y})
                </span>
                <span>
                  Anchor: ({(slot.anchorX * 100).toFixed(0)}%, {(slot.anchorY * 100).toFixed(0)}%)
                </span>
              </div>
            ))}
            {slots.length === 0 && (
              <div className={styles.emptySlots}>
                No slots defined. Use Draw mode to add one.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
