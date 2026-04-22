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

interface TextConfig {
  x: number;
  y: number;
  fontSize: number;
  color: string;
  fontPath: string;
  maxWidth: number;
  align: 'left' | 'center' | 'right';
  uppercase: boolean;
}

const defaultTextConfig = (): TextConfig => ({
  x: 100,
  y: 100,
  fontSize: 60,
  color: '#FFFFFF',
  fontPath: '',
  maxWidth: 0,
  align: 'left',
  uppercase: false,
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

  // Magazine text overlay configs
  const [nameTextConfig, setNameTextConfig] = useState<TextConfig>(defaultTextConfig());
  const [designationTextConfig, setDesignationTextConfig] = useState<TextConfig>({ ...defaultTextConfig(), y: 180, fontSize: 40 });
  const [hasNameText, setHasNameText] = useState(false);
  const [hasDesignationText, setHasDesignationText] = useState(false);

  // Dragging state for text markers
  const [draggingText, setDraggingText] = useState<'name' | 'designation' | null>(null);

  // FG drag + snap guide state
  const [fgOffset, setFgOffset] = useState({ x: 0, y: 0 });
  const [isDraggingFg, setIsDraggingFg] = useState(false);
  const [activeGuides, setActiveGuides] = useState<SnapGuide[]>([]);
  const fgDragAnchorRef = useRef<{ mouseX: number; mouseY: number; startX: number; startY: number } | null>(null);

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

        // Load magazine text configs
        if (config.name_text && typeof config.name_text === 'object') {
          setNameTextConfig({
            x: config.name_text.x ?? 100,
            y: config.name_text.y ?? 100,
            fontSize: config.name_text.fontSize ?? 60,
            color: config.name_text.color ?? '#FFFFFF',
            fontPath: config.name_text.fontPath ?? '',
            maxWidth: config.name_text.maxWidth ?? 0,
            align: config.name_text.align ?? 'left',
            uppercase: config.name_text.uppercase ?? false,
          });
          setHasNameText(true);
        }
        if (config.designation_text && typeof config.designation_text === 'object') {
          setDesignationTextConfig({
            x: config.designation_text.x ?? 100,
            y: config.designation_text.y ?? 180,
            fontSize: config.designation_text.fontSize ?? 40,
            color: config.designation_text.color ?? '#FFFFFF',
            fontPath: config.designation_text.fontPath ?? '',
            maxWidth: config.designation_text.maxWidth ?? 0,
            align: config.designation_text.align ?? 'left',
            uppercase: config.designation_text.uppercase ?? false,
          });
          setHasDesignationText(true);
        }

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

    // Draw magazine text position indicators
    if (compositeMode === 'magazine') {
      const drawTextMarker = (cfg: TextConfig, label: string, color: string, isDragging: boolean) => {
        const tx = cfg.x * scale;
        const ty = cfg.y * scale;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = isDragging ? 3 : 2;
        ctx.globalAlpha = isDragging ? 1 : 0.85;
        ctx.setLineDash([4, 4]);
        // Horizontal guide line
        ctx.beginPath();
        ctx.moveTo(tx - 10, ty);
        ctx.lineTo(tx + 120, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        // Vertical tick
        ctx.beginPath();
        ctx.moveTo(tx, ty - 8);
        ctx.lineTo(tx, ty + 8);
        ctx.stroke();
        // Drag handle circle
        ctx.beginPath();
        ctx.arc(tx, ty, isDragging ? 7 : 5, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        // Label with background pill
        const fontSize = Math.max(11, 13 * scale);
        ctx.font = `bold ${fontSize}px sans-serif`;
        const textW = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.beginPath();
        ctx.roundRect(tx + 10, ty - fontSize - 2, textW + 8, fontSize + 4, 3);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(label, tx + 14, ty - 4);
        ctx.globalAlpha = 1;
        ctx.restore();
      };
      if (hasNameText) drawTextMarker(nameTextConfig, 'NAME', '#facc15', draggingText === 'name');
      if (hasDesignationText) drawTextMarker(designationTextConfig, 'DESIGNATION', '#4ade80', draggingText === 'designation');
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
  }, [imageLoaded, imageDimensions, scale, slots, selectedSlotIndex, isDrawing, mode, drawStart, drawCurrent, fgImageRef, showFgOverlay, compositeMode, hasNameText, nameTextConfig, hasDesignationText, designationTextConfig, draggingText, fgOffset, activeGuides]);

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

    // Check for text marker drag (works in any non-fg mode when magazine)
    if (compositeMode === 'magazine') {
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
      const nx = Math.round(Math.max(0, coords.x));
      const ny = Math.round(Math.max(0, coords.y));
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
            <>
              <div className={styles.settingRow} style={{ background: 'rgba(99,102,241,0.1)', borderRadius: 6, padding: '8px 10px' }}>
                <span style={{ fontSize: '0.78rem', color: '#a5b4fc' }}>
                  📰 Magazine mode: the BG image (uploaded at creation) goes behind the user. Upload the FG overlay (title, text, borders) via the Magazine tab after saving.
                </span>
              </div>

              {/* Name text config */}
              <div className={styles.settingRow} style={{ marginTop: '1rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hasNameText} onChange={e => setHasNameText(e.target.checked)} style={{ width: 16, height: 16 }} />
                  <strong>Name Text</strong>
                </label>
              </div>
              {hasNameText && (
                <div style={{ paddingLeft: 12, borderLeft: '2px solid #facc15', marginBottom: 8 }}>
                  <div className={styles.settingRow}>
                    <label>Position (X, Y):</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="number" value={nameTextConfig.x} onChange={e => setNameTextConfig(p => ({ ...p, x: +e.target.value }))} style={{ width: 70 }} />
                      <input type="number" value={nameTextConfig.y} onChange={e => setNameTextConfig(p => ({ ...p, y: +e.target.value }))} style={{ width: 70 }} />
                    </div>
                  </div>
                  <div className={styles.settingRow}>
                    <label>Font Size:</label>
                    <input type="number" value={nameTextConfig.fontSize} onChange={e => setNameTextConfig(p => ({ ...p, fontSize: +e.target.value }))} style={{ width: 70 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Color:</label>
                    <input type="color" value={nameTextConfig.color} onChange={e => setNameTextConfig(p => ({ ...p, color: e.target.value }))} />
                    <input type="text" value={nameTextConfig.color} onChange={e => setNameTextConfig(p => ({ ...p, color: e.target.value }))} style={{ width: 80 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Max Width (0=none):</label>
                    <input type="number" value={nameTextConfig.maxWidth} onChange={e => setNameTextConfig(p => ({ ...p, maxWidth: +e.target.value }))} style={{ width: 80 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Align:</label>
                    <select value={nameTextConfig.align} onChange={e => setNameTextConfig(p => ({ ...p, align: e.target.value as 'left' | 'center' | 'right' }))}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={nameTextConfig.uppercase} onChange={e => setNameTextConfig(p => ({ ...p, uppercase: e.target.checked }))} />
                      Uppercase
                    </label>
                  </div>
                  <div className={styles.settingRow}>
                    <label>Font Path (optional):</label>
                    <input type="text" value={nameTextConfig.fontPath} onChange={e => setNameTextConfig(p => ({ ...p, fontPath: e.target.value }))} placeholder="/app/fonts/MyFont.ttf" style={{ width: '100%' }} />
                  </div>
                </div>
              )}

              {/* Designation text config */}
              <div className={styles.settingRow} style={{ marginTop: '0.5rem' }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={hasDesignationText} onChange={e => setHasDesignationText(e.target.checked)} style={{ width: 16, height: 16 }} />
                  <strong>Designation Text</strong>
                </label>
              </div>
              {hasDesignationText && (
                <div style={{ paddingLeft: 12, borderLeft: '2px solid #4ade80', marginBottom: 8 }}>
                  <div className={styles.settingRow}>
                    <label>Position (X, Y):</label>
                    <div style={{ display: 'flex', gap: 6 }}>
                      <input type="number" value={designationTextConfig.x} onChange={e => setDesignationTextConfig(p => ({ ...p, x: +e.target.value }))} style={{ width: 70 }} />
                      <input type="number" value={designationTextConfig.y} onChange={e => setDesignationTextConfig(p => ({ ...p, y: +e.target.value }))} style={{ width: 70 }} />
                    </div>
                  </div>
                  <div className={styles.settingRow}>
                    <label>Font Size:</label>
                    <input type="number" value={designationTextConfig.fontSize} onChange={e => setDesignationTextConfig(p => ({ ...p, fontSize: +e.target.value }))} style={{ width: 70 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Color:</label>
                    <input type="color" value={designationTextConfig.color} onChange={e => setDesignationTextConfig(p => ({ ...p, color: e.target.value }))} />
                    <input type="text" value={designationTextConfig.color} onChange={e => setDesignationTextConfig(p => ({ ...p, color: e.target.value }))} style={{ width: 80 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Max Width (0=none):</label>
                    <input type="number" value={designationTextConfig.maxWidth} onChange={e => setDesignationTextConfig(p => ({ ...p, maxWidth: +e.target.value }))} style={{ width: 80 }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label>Align:</label>
                    <select value={designationTextConfig.align} onChange={e => setDesignationTextConfig(p => ({ ...p, align: e.target.value as 'left' | 'center' | 'right' }))}>
                      <option value="left">Left</option>
                      <option value="center">Center</option>
                      <option value="right">Right</option>
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={designationTextConfig.uppercase} onChange={e => setDesignationTextConfig(p => ({ ...p, uppercase: e.target.checked }))} />
                      Uppercase
                    </label>
                  </div>
                  <div className={styles.settingRow}>
                    <label>Font Path (optional):</label>
                    <input type="text" value={designationTextConfig.fontPath} onChange={e => setDesignationTextConfig(p => ({ ...p, fontPath: e.target.value }))} placeholder="/app/fonts/MyFont.ttf" style={{ width: '100%' }} />
                  </div>
                </div>
              )}
            </>
          )}
          
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
