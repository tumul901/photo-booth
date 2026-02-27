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

interface TemplateConfig {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker';
  compositeMode: 'background' | 'overlay';
  pngUrl: string;
  anchorMode: 'face_center' | 'eyes' | 'none';
  dimensions: { width: number; height: number };
  slots: SlotConfig[];
  desiredFaceRatio: number;
  minZoom: number;
  maxZoom: number;
}

interface TemplateEditorProps {
  templateId: string;
  templateName: string;
  imageUrl: string;
  initialConfig?: Partial<TemplateConfig>;
  onSave: (config: TemplateConfig) => void;
  onCancel: () => void;
}

type EditorMode = 'select' | 'draw' | 'anchor';

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
  
  // Config settings
  const [templateType, setTemplateType] = useState<'frame' | 'sticker'>('sticker');
  const [compositeMode, setCompositeMode] = useState<'background' | 'overlay'>('background');
  const [anchorMode, setAnchorMode] = useState<'face_center' | 'eyes' | 'none'>('face_center');
  const [desiredFaceRatio, setDesiredFaceRatio] = useState(0.25);
  const [minZoom, setMinZoom] = useState(0.5);
  const [maxZoom, setMaxZoom] = useState(2.5);
  const [imageError, setImageError] = useState<string | null>(null);

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
        if (config.anchorMode) setAnchorMode(config.anchorMode);
        if (config.desiredFaceRatio) setDesiredFaceRatio(config.desiredFaceRatio);
        if (config.minZoom) setMinZoom(config.minZoom);
        if (config.maxZoom) setMaxZoom(config.maxZoom);
        
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
  }, [imageLoaded, imageDimensions, scale, slots, selectedSlotIndex, isDrawing, mode, drawStart, drawCurrent]);

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

  // Mouse handlers
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const coords = getImageCoords(e);
    
    if (mode === 'draw') {
      setIsDrawing(true);
      setDrawStart({ x: coords.x * scale, y: coords.y * scale });
      setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
    } else if (mode === 'anchor' && selectedSlotIndex !== null) {
      // Set anchor point within selected slot
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
      // Select slot if clicked inside
      const clickedIndex = slots.findIndex(slot =>
        coords.x >= slot.x && coords.x <= slot.x + slot.width &&
        coords.y >= slot.y && coords.y <= slot.y + slot.height
      );
      setSelectedSlotIndex(clickedIndex >= 0 ? clickedIndex : null);
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    if (isDrawing && mode === 'draw') {
      const coords = getImageCoords(e);
      setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
    }
  };

  const handleMouseUp = () => {
    if (isDrawing && mode === 'draw') {
      // Finalize the slot
      const x = Math.min(drawStart.x, drawCurrent.x) / scale;
      const y = Math.min(drawStart.y, drawCurrent.y) / scale;
      const width = Math.abs(drawCurrent.x - drawStart.x) / scale;
      const height = Math.abs(drawCurrent.y - drawStart.y) / scale;
      
      // Only add if slot is reasonably sized
      if (width > 50 && height > 50) {
        const newSlot: SlotConfig = {
          id: `slot${slots.length + 1}`,
          x: Math.round(x),
          y: Math.round(y),
          width: Math.round(width),
          height: Math.round(height),
          anchorX: 0.5, // Default center
          anchorY: 0.35, // Default upper third (face area)
        };
        setSlots(prev => [...prev, newSlot]);
        setSelectedSlotIndex(slots.length);
        setMode('anchor'); // Switch to anchor mode after drawing
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
    if (slots.length === 0) {
      alert('Please draw at least one slot');
      return;
    }

    const config: TemplateConfig = {
      templateId,
      name: templateName,
      templateType,
      compositeMode,
      pngUrl: imageUrl.split('/').pop() || '',
      anchorMode,
      dimensions: imageDimensions,
      slots: slots.map(slot => ({
        ...slot,
        // Convert relative anchor to absolute for JSON
        anchorX: slot.anchorX,
        anchorY: slot.anchorY,
      })),
      desiredFaceRatio,
      minZoom,
      maxZoom,
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
            style={{ cursor: mode === 'draw' ? 'crosshair' : mode === 'anchor' ? 'pointer' : 'default' }}
          />
          
          {/* Instructions overlay */}
          <div className={styles.instructions}>
            {mode === 'draw' && '🖱️ Drag to draw a slot rectangle'}
            {mode === 'anchor' && selectedSlotIndex !== null && '🎯 Click inside the slot to set face anchor point'}
            {mode === 'select' && '👆 Click on a slot to select it'}
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
            </select>
          </div>
          
          <div className={styles.settingRow}>
            <label>Composite Mode:</label>
            <select value={compositeMode} onChange={e => setCompositeMode(e.target.value as typeof compositeMode)}>
              <option value="background">Background (template behind sticker)</option>
              <option value="overlay">Overlay (template over photo)</option>
            </select>
          </div>
          
          <div className={styles.settingRow}>
            <label>Anchor Mode:</label>
            <select value={anchorMode} onChange={e => setAnchorMode(e.target.value as typeof anchorMode)}>
              <option value="face_center">Face Center</option>
              <option value="eyes">Eyes</option>
              <option value="none">None (Bottom anchor)</option>
            </select>
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
