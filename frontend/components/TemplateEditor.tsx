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
});

interface SnapGuide {
  axis: 'x' | 'y'; // 'x' = vertical line, 'y' = horizontal line
  position: number; // in image (unscaled) coordinates
}

const SNAP_THRESHOLD = 12; // px in image space

function computeSnap(
  nx: number, ny: number,
  fgW: number, fgH: number,
  canvasW: number, canvasH: number,
): { snappedX: number; snappedY: number; guides: SnapGuide[] } {
  const xRefs = [0, canvasW / 3, canvasW / 2, (2 * canvasW) / 3, canvasW];
  const yRefs = [0, canvasH / 3, canvasH / 2, (2 * canvasH) / 3, canvasH];

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
  if (minDX < SNAP_THRESHOLD) guides.push({ axis: 'x', position: bestXRef });
  if (minDY < SNAP_THRESHOLD) guides.push({ axis: 'y', position: bestYRef });
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
  anchorMode: 'face_center' | 'eyes' | 'none';
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

type EditorMode = 'select' | 'draw' | 'anchor' | 'fg';

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
  const [anchorMode, setAnchorMode] = useState<'face_center' | 'eyes' | 'none'>('face_center');
  const [desiredFaceRatio, setDesiredFaceRatio] = useState(0.25);
  const [minZoom, setMinZoom] = useState(0.5);
  const [maxZoom, setMaxZoom] = useState(2.5);
  const [showVisualGuide, setShowVisualGuide] = useState(false);
  const [allowManualPositioning, setAllowManualPositioning] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);

  // Text overlay configs (magazine + sticker/luggage card)
  const [nameTextConfig, setNameTextConfig] = useState<TextConfig>(defaultTextConfig());
  const [designationTextConfig, setDesignationTextConfig] = useState<TextConfig>({ ...defaultTextConfig(), y: 180, fontSize: 40 });
  const [hasNameText, setHasNameText] = useState(false);
  const [hasDesignationText, setHasDesignationText] = useState(false);

  // Custom fonts
  const [fonts, setFonts] = useState<FontItem[]>([]);

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

  // Load available custom fonts
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/admin/fonts`)
      .then(r => r.json())
      .then(d => setFonts(d.fonts ?? []))
      .catch(() => {});
  }, []);

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
    
    // Set canvas size
    canvas.width = imageDimensions.width * scale;
    canvas.height = imageDimensions.height * scale;
    
    // Clear and draw image
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    
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
    
    // Draw FG overlay for magazine mode (semi-transparent so slots are still visible)
    if (fgImageRef && showFgOverlay && compositeMode === 'magazine') {
      const fgDrawW = (fgImageRef.naturalWidth || imageDimensions.width) * scale;
      const fgDrawH = (fgImageRef.naturalHeight || imageDimensions.height) * scale;
      ctx.globalAlpha = 0.6;
      ctx.drawImage(fgImageRef, fgOffset.x * scale, fgOffset.y * scale, fgDrawW, fgDrawH);
      ctx.globalAlpha = 1.0;
    }

    // Draw snap alignment guides (shown while dragging FG)
    if (activeGuides.length > 0) {
      ctx.save();
      ctx.strokeStyle = '#00d4ff';
      ctx.lineWidth = 1.5;
      ctx.globalAlpha = 0.9;
      ctx.setLineDash([]);
      for (const guide of activeGuides) {
        ctx.beginPath();
        if (guide.axis === 'x') {
          ctx.moveTo(guide.position * scale, 0);
          ctx.lineTo(guide.position * scale, canvas.height);
        } else {
          ctx.moveTo(0, guide.position * scale);
          ctx.lineTo(canvas.width, guide.position * scale);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // Draw text overlay position indicators (any composite mode when overlays are enabled)
    if (hasNameText || hasDesignationText) {
      const drawTextMarker = (cfg: TextConfig, label: string, color: string, isDragging: boolean) => {
        const tx = cfg.x * scale;
        const ty = cfg.y * scale;
        ctx.save();
        ctx.translate(tx, ty);
        // Show rotation direction visually
        if (cfg.rotation !== 0) {
          const rad = -cfg.rotation * Math.PI / 180; // canvas CW = PIL CCW
          ctx.rotate(rad);
        }
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = isDragging ? 3 : 2;
        ctx.globalAlpha = isDragging ? 1 : 0.85;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(-10, 0);
        ctx.lineTo(120, 0);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(0, -8);
        ctx.lineTo(0, 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(0, 0, isDragging ? 7 : 5, 0, Math.PI * 2);
        ctx.fill();
        const fontSize = Math.max(11, 13 * scale);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const textW = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.roundRect(10, -fontSize - 2, textW + 8, fontSize + 4, 3);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(label, 14, -4);
        if (cfg.rotation !== 0) {
          ctx.fillStyle = color;
          ctx.font = `${Math.max(9, 10 * scale)}px sans-serif`;
          ctx.fillText(`${cfg.rotation.toFixed(0)}°`, 14, fontSize + 2);
        }
        ctx.globalAlpha = 1;
        ctx.restore();
      };
      if (hasNameText) drawTextMarker(nameTextConfig, 'NAME', '#facc15', draggingText === 'name');
      if (hasDesignationText) drawTextMarker(designationTextConfig, 'DESIGNATION', '#4ade80', draggingText === 'designation');
    }

    // Ruler overlay for luggage card mode
    if (luggageCardMode && imageDimensions.width > 0) {
      const mmPerPx = printWidthMm / imageDimensions.width;
      const pxPer10mm = (10 / mmPerPx) * scale;
      ctx.save();
      ctx.strokeStyle = 'rgba(100,180,255,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (let xmm = 10; xmm < printWidthMm; xmm += 10) {
        const xpx = (xmm / printWidthMm) * canvas.width;
        ctx.beginPath(); ctx.moveTo(xpx, 0); ctx.lineTo(xpx, canvas.height); ctx.stroke();
      }
      for (let ymm = 10; ymm < printHeightMm; ymm += 10) {
        const ypx = (ymm / printHeightMm) * canvas.height;
        ctx.beginPath(); ctx.moveTo(0, ypx); ctx.lineTo(canvas.width, ypx); ctx.stroke();
      }
      ctx.setLineDash([]);
      // mm labels along top
      ctx.fillStyle = 'rgba(100,180,255,0.7)';
      ctx.font = `${Math.max(8, 9 * scale)}px sans-serif`;
      for (let xmm = 10; xmm < printWidthMm; xmm += 10) {
        const xpx = (xmm / printWidthMm) * canvas.width;
        ctx.fillText(`${xmm}`, xpx + 2, 10 * scale);
      }
      ctx.restore();
      void pxPer10mm; // suppress unused warning
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
  }, [imageLoaded, imageDimensions, scale, slots, selectedSlotIndex, isDrawing, mode, drawStart, drawCurrent, fgImageRef, showFgOverlay, compositeMode, hasNameText, nameTextConfig, hasDesignationText, designationTextConfig, draggingText, fgOffset, activeGuides, luggageCardMode, printWidthMm, printHeightMm]);

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

  // Hit-test: is (x,y) in image coords near a text marker? Returns grab target or null.
  const hitTestTextMarker = (x: number, y: number): 'name' | 'designation' | null => {
    const HIT = 20; // px in image space
    if (hasNameText && Math.abs(x - nameTextConfig.x) < HIT && Math.abs(y - nameTextConfig.y) < HIT) return 'name';
    if (hasDesignationText && Math.abs(x - designationTextConfig.x) < HIT && Math.abs(y - designationTextConfig.y) < HIT) return 'designation';
    return null;
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

    // Check for text marker drag (works whenever overlays are enabled)
    if (hasNameText || hasDesignationText) {
      const hit = hitTestTextMarker(coords.x, coords.y);
      if (hit) {
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

    if (mode === 'fg' && fgDragAnchorRef.current) {
      const fgW = fgImageRef?.naturalWidth || imageDimensions.width;
      const fgH = fgImageRef?.naturalHeight || imageDimensions.height;
      const dx = coords.x - fgDragAnchorRef.current.mouseX;
      const dy = coords.y - fgDragAnchorRef.current.mouseY;
      const nx = fgDragAnchorRef.current.startX + dx;
      const ny = fgDragAnchorRef.current.startY + dy;
      const { snappedX, snappedY, guides } = computeSnap(nx, ny, fgW, fgH, imageDimensions.width, imageDimensions.height);
      setFgOffset({ x: Math.round(snappedX), y: Math.round(snappedY) });
      setActiveGuides(guides);
      return;
    }

    if (draggingText) {
      const rawX = Math.max(0, coords.x);
      const rawY = Math.max(0, coords.y);
      // Snap to grid (canvas edges/thirds/center) + snap to the OTHER text marker
      const otherCfg = draggingText === 'name' ? designationTextConfig : nameTextConfig;
      const otherEnabled = draggingText === 'name' ? hasDesignationText : hasNameText;
      const { snappedX, snappedY, guides } = computeSnap(
        rawX, rawY, 1, 1, imageDimensions.width, imageDimensions.height,
      );
      // Also check cross-marker snap
      let finalX = snappedX, finalY = snappedY;
      const crossGuides: SnapGuide[] = [...guides];
      if (otherEnabled) {
        if (Math.abs(rawX - otherCfg.x) < 12) { finalX = otherCfg.x; crossGuides.push({ axis: 'x', position: otherCfg.x }); }
        if (Math.abs(rawY - otherCfg.y) < 12) { finalY = otherCfg.y; crossGuides.push({ axis: 'y', position: otherCfg.y }); }
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

  // Save configuration
  const handleSave = () => {
    if (templateType === 'sticker' && slots.length === 0) {
      alert('Please draw at least one slot for Sticker templates');
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
            onMouseLeave={handleMouseUp}
            style={{ cursor: draggingText ? 'grabbing' : mode === 'fg' ? (isDraggingFg ? 'grabbing' : 'grab') : mode === 'draw' ? 'crosshair' : mode === 'anchor' ? 'pointer' : 'default' }}
          />
          
          {/* Instructions overlay */}
          <div className={styles.instructions}>
            {mode === 'draw' && '🖱️ Drag to draw a slot rectangle'}
            {mode === 'anchor' && selectedSlotIndex !== null && '🎯 Click inside the slot to set face anchor point'}
            {mode === 'select' && '👆 Click on a slot to select it'}
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
            Drag the markers on the canvas to position. Hold Shift while dragging to disable snap.
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
            ) => (
              <div style={{ marginBottom: 8 }}>
                <div className={styles.settingRow}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} style={{ width: 16, height: 16 }} />
                    <strong style={{ color: accentColor }}>{label}</strong>
                  </label>
                </div>
                {enabled && (
                  <div style={{ paddingLeft: 12, borderLeft: `2px solid ${accentColor}`, marginBottom: 8 }}>
                    <div className={styles.settingRow}>
                      <label>Position (X, Y) — drag on canvas:</label>
                      <div style={{ display: 'flex', gap: 6 }}>
                        <input type="number" value={cfg.x} onChange={e => setCfg({ ...cfg, x: +e.target.value })} style={{ width: 70 }} />
                        <input type="number" value={cfg.y} onChange={e => setCfg({ ...cfg, y: +e.target.value })} style={{ width: 70 }} />
                      </div>
                    </div>
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
                      <input type="number" value={cfg.fontSize} onChange={e => setCfg({ ...cfg, fontSize: +e.target.value })} style={{ width: 70 }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Color:</label>
                      <input type="color" value={cfg.color} onChange={e => setCfg({ ...cfg, color: e.target.value })} />
                      <input type="text" value={cfg.color} onChange={e => setCfg({ ...cfg, color: e.target.value })} style={{ width: 80 }} />
                    </div>
                    <div className={styles.settingRow}>
                      <label>Font:</label>
                      <select value={cfg.fontName} onChange={e => setCfg({ ...cfg, fontName: e.target.value, fontPath: '' })}>
                        <option value="">Default</option>
                        {fonts.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                      </select>
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
                  </div>
                )}
              </div>
            );
            return (
              <>
                {renderOverlay('Name Text', '#facc15', hasNameText, setHasNameText, nameTextConfig, setNameTextConfig)}
                {renderOverlay('Designation Text', '#4ade80', hasDesignationText, setHasDesignationText, designationTextConfig, setDesignationTextConfig)}
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
              <option value="face_center">Face Center</option>
              <option value="eyes">Eyes</option>
              <option value="full_frame">Full Frame (1:1 UI Overlay)</option>
              <option value="none">None (Bottom anchor)</option>
            </select>
          </div>
          
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
