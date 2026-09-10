"use client";

import React, { useState, useRef, useEffect, useCallback } from 'react';
import styles from './WTMSlotEditor.module.css';
import { WTMTemplateConfig, SlotDefinition, PhotoSlotDefinition, TextOverlayConfig, Baseline } from '@/types/wtm';

interface WTMSlotEditorProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onSaved: () => void;
  onBack: () => void;
}

type EditorTab = 'words' | 'photo' | 'settings' | 'text';
type PhotoEditorMode = 'draw' | 'anchor' | 'select' | 'baseline';

const DEFAULT_PHOTO_SLOT: Omit<PhotoSlotDefinition, 'x' | 'y' | 'width' | 'height'> = {
  anchor_x: 0.5,
  anchor_y: 0.35,
  anchor_mode: 'face_center',
  desired_face_ratio: 0.35,
  min_zoom: 0.5,
  max_zoom: 3.0,
  sticker_filter: 'none',
};

type WordsDragMode = 'none' | 'draw' | 'move' | 'resize';

const getSlotAt = (cx: number, cy: number, slots: SlotDefinition[]): number | null => {
  for (let i = slots.length - 1; i >= 0; i--) {
    const { x, y, width, height } = slots[i];
    if (cx >= x && cx <= x + width && cy >= y && cy <= y + height) return i;
  }
  return null;
};

const getResizeHandleAt = (
  cx: number, cy: number, slot: SlotDefinition, scaleFactor: number
): 'nw' | 'ne' | 'sw' | 'se' | null => {
  const r = 10 / scaleFactor;
  if (Math.hypot(cx - slot.x, cy - slot.y) <= r) return 'nw';
  if (Math.hypot(cx - (slot.x + slot.width), cy - slot.y) <= r) return 'ne';
  if (Math.hypot(cx - slot.x, cy - (slot.y + slot.height)) <= r) return 'sw';
  if (Math.hypot(cx - (slot.x + slot.width), cy - (slot.y + slot.height)) <= r) return 'se';
  return null;
};

const handleToCursor = (h: 'nw' | 'ne' | 'sw' | 'se'): string =>
  ({ nw: 'nw-resize', ne: 'ne-resize', sw: 'sw-resize', se: 'se-resize' }[h]);

// Custom crosshair cursor: white halo + black lines → visible on any background color
const CROSSHAIR_CURSOR =
  `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='24' height='24'%3E` +
  `%3Cline x1='12' y1='1' x2='12' y2='23' stroke='white' stroke-width='3'/%3E` +
  `%3Cline x1='1' y1='12' x2='23' y2='12' stroke='white' stroke-width='3'/%3E` +
  `%3Cline x1='12' y1='1' x2='12' y2='23' stroke='black' stroke-width='1'/%3E` +
  `%3Cline x1='1' y1='12' x2='23' y2='12' stroke='black' stroke-width='1'/%3E` +
  `%3C/svg%3E") 12 12, crosshair`;

const WTMSlotEditor: React.FC<WTMSlotEditorProps> = ({ config, apiBaseUrl, onSaved, onBack: _onBack }) => {
  const [tab, setTab] = useState<EditorTab>('words');

  // ── Word slots ──────────────────────────────────────────────────────────
  const [slots, setSlots] = useState<SlotDefinition[]>(config.slots);
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
  const [wordsDirty, setWordsDirty] = useState(false);
  const [wordsSaving, setWordsSaving] = useState(false);
  const [wordsSaveError, setWordsSaveError] = useState<string | null>(null);

  // ── Photo slot ──────────────────────────────────────────────────────────
  const [photoSlot, setPhotoSlot] = useState<PhotoSlotDefinition | null>(config.photo_slot);
  const [photoMode, setPhotoMode] = useState<PhotoEditorMode>('draw');
  const [photoDirty, setPhotoDirty] = useState(false);
  const [photoSaving, setPhotoSaving] = useState(false);
  const [photoSaveError, setPhotoSaveError] = useState<string | null>(null);

  // ── Baseline placement (mirrors TemplateEditor.tsx's baseline tool) ─────
  // Kept as its own state rather than nested in `photoSlot` during editing —
  // same separation the reference implementation uses, and it avoids rebuilding
  // the whole photoSlot object on every drag-move pixel. Merged into photoSlot
  // only at save time (see handleSavePhotoSlot).
  const [baseline, setBaseline] = useState<Baseline | null>(config.photo_slot?.baseline ?? null);
  const [baselineDraft, setBaselineDraft] = useState<Baseline | null>(null);
  const isDrawingBaseline = useRef(false);
  const [draggingBaseline, setDraggingBaseline] = useState<null | 'move' | 'x1' | 'x2'>(null);
  const [baselineHover, setBaselineHover] = useState<null | 'move' | 'x1' | 'x2'>(null);
  const baselineDragRef = useRef<{ grabX: number; grabY: number; orig: Baseline } | null>(null);

  // ── Template settings ────────────────────────────────────────────────────
  const [allowManualPositioning, setAllowManualPositioning] = useState(config.allow_manual_positioning ?? true);
  const [maxSelections, setMaxSelections] = useState(config.max_selections ?? 6);
  const [settingsDirty, setSettingsDirty] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);

  // ── Word slot drag/move/resize state ────────────────────────────────────
  const [wordsDragMode, setWordsDragMode] = useState<WordsDragMode>('none');
  const [wordsDragIdx, setWordsDragIdx] = useState<number | null>(null);
  const [wordsDragOffset, setWordsDragOffset] = useState({ x: 0, y: 0 });
  const [wordsDragFixed, setWordsDragFixed] = useState({ x: 0, y: 0 });

  const [wordsCursor, setWordsCursor] = useState<string>(CROSSHAIR_CURSOR);

  // ── Text overlay state ───────────────────────────────────────────────────
  const EMPTY_TEXT_CFG = (y = 100): TextOverlayConfig => ({
    x: 60, y, font_size: 60, color: '#000000', font_name: '', max_width: 0, align: 'left', uppercase: false,
  });
  const [fonts, setFonts] = useState<{ name: string; path: string }[]>([]);
  const [nameEnabled, setNameEnabled] = useState(!!config.name_text);
  const [nameCfg, setNameCfg] = useState<TextOverlayConfig>(config.name_text ?? EMPTY_TEXT_CFG(100));
  const [desigEnabled, setDesigEnabled] = useState(!!config.designation_text);
  const [desigCfg, setDesigCfg] = useState<TextOverlayConfig>(config.designation_text ?? EMPTY_TEXT_CFG(200));
  const [draggingText, setDraggingText] = useState<'name' | 'designation' | null>(null);
  const [textDirty, setTextDirty] = useState(false);
  const [textSaving, setTextSaving] = useState(false);
  const [textSaveError, setTextSaveError] = useState<string | null>(null);

  // ── Shared canvas state ─────────────────────────────────────────────────
  const [scale, setScale] = useState(1);
  const [isDrawing, setIsDrawing] = useState(false);
  const [drawStart, setDrawStart] = useState({ x: 0, y: 0 });
  const [drawCurrent, setDrawCurrent] = useState({ x: 0, y: 0 });

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);

  // ── Canvas sizing ───────────────────────────────────────────────────────
  const handleImageLoad = () => {
    if (!canvasRef.current || !imageRef.current) return;
    const img = imageRef.current;
    canvasRef.current.width = img.clientWidth;
    canvasRef.current.height = img.clientHeight;
    setScale(img.clientWidth / img.naturalWidth);
  };

  useEffect(() => {
    const el = imageRef.current;
    if (!el) return;
    const observer = new ResizeObserver(handleImageLoad);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/admin/wtm/fonts`)
      .then(r => r.json())
      .then(d => setFonts(d.fonts ?? []))
      .catch(() => {});
  }, [apiBaseUrl]);

  // ── Canvas redraw ───────────────────────────────────────────────────────
  const redrawCanvas = useCallback(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    const img = imageRef.current;
    if (!canvas || !ctx || !img) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    if (tab === 'words') {
      // Draw word slots (red) — rotated around slot centre
      slots.forEach((slot, index) => {
        const isSel = index === selectedSlotIndex;
        const cx = (slot.x + slot.width / 2) * scale;
        const cy = (slot.y + slot.height / 2) * scale;
        const rad = ((slot.rotation ?? 0) * Math.PI) / 180;
        const hw = (slot.width * scale) / 2;
        const hh = (slot.height * scale) / 2;

        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(rad);

        ctx.strokeStyle = isSel ? '#00ff00' : '#ff6b6b';
        ctx.lineWidth = isSel ? 3 : 2;
        ctx.setLineDash([5, 5]);
        ctx.strokeRect(-hw, -hh, slot.width * scale, slot.height * scale);
        ctx.setLineDash([]);
        ctx.fillStyle = isSel ? 'rgba(0,255,0,0.1)' : 'rgba(255,107,107,0.1)';
        ctx.fillRect(-hw, -hh, slot.width * scale, slot.height * scale);
        ctx.fillStyle = isSel ? '#00ff00' : '#ff6b6b';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText(`Word ${slot.order + 1}`, -hw + 5, -hh + 18);

        // Corner resize handles on selected slot
        if (isSel) {
          const corners: [number, number][] = [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]];
          corners.forEach(([hx, hy]) => {
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(hx - 5, hy - 5, 10, 10);
            ctx.strokeStyle = '#00ff00';
            ctx.lineWidth = 1.5;
            ctx.strokeRect(hx - 5, hy - 5, 10, 10);
          });
        }

        ctx.restore();
      });
    } else {
      // Draw photo slot (blue) with anchor crosshair
      if (photoSlot) {
        const { x, y, width, height, anchor_x, anchor_y } = photoSlot;
        ctx.strokeStyle = '#4f8ef7';
        ctx.lineWidth = 3;
        ctx.setLineDash([6, 4]);
        ctx.strokeRect(x * scale, y * scale, width * scale, height * scale);
        ctx.setLineDash([]);
        ctx.fillStyle = 'rgba(79,142,247,0.1)';
        ctx.fillRect(x * scale, y * scale, width * scale, height * scale);
        ctx.fillStyle = '#4f8ef7';
        ctx.font = 'bold 14px sans-serif';
        ctx.fillText('📷 User Photo', x * scale + 5, y * scale + 20);

        // Anchor point — yellow dot + crosshair (same as TemplateEditor)
        const ax = (x + width * anchor_x) * scale;
        const ay = (y + height * anchor_y) * scale;
        ctx.beginPath();
        ctx.arc(ax, ay, 8, 0, Math.PI * 2);
        ctx.fillStyle = '#ffcc00';
        ctx.fill();
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.strokeStyle = '#ffcc00';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ax - 14, ay); ctx.lineTo(ax + 14, ay);
        ctx.moveTo(ax, ay - 14); ctx.lineTo(ax, ay + 14);
        ctx.stroke();
      }

      // Baseline (green) — draft while drawing takes precedence over the committed one
      const blToDraw = baselineDraft || baseline;
      if (blToDraw) {
        const bx1 = blToDraw.x1 * scale, bx2 = blToDraw.x2 * scale, by = blToDraw.y * scale;
        const blActive = !!(draggingBaseline || baselineHover);
        ctx.strokeStyle = '#22ff88';
        ctx.lineWidth = blActive ? 3 : 2;
        ctx.beginPath();
        ctx.moveTo(bx1, by); ctx.lineTo(bx2, by);
        ctx.stroke();

        (['x1', 'x2'] as const).forEach((key) => {
          const hx = key === 'x1' ? bx1 : bx2;
          const isActiveEnd = draggingBaseline === key || baselineHover === key;
          ctx.beginPath();
          ctx.arc(hx, by, isActiveEnd ? 8 : 6, 0, Math.PI * 2);
          ctx.fillStyle = '#22ff88';
          ctx.fill();
          ctx.strokeStyle = '#000';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        });

        ctx.fillStyle = '#22ff88';
        ctx.font = 'bold 12px sans-serif';
        ctx.fillText('📏 baseline', Math.min(bx1, bx2) + 4, by - 8);
      }
    }

    // In-progress rectangle while dragging (words / photo tabs only)
    if ((isDrawing || wordsDragMode === 'draw') && tab !== 'text') {
      const rx = Math.min(drawStart.x, drawCurrent.x);
      const ry = Math.min(drawStart.y, drawCurrent.y);
      const rw = Math.abs(drawCurrent.x - drawStart.x);
      const rh = Math.abs(drawCurrent.y - drawStart.y);
      ctx.strokeStyle = tab === 'photo' ? '#4f8ef7' : '#00ccff';
      ctx.lineWidth = 2;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(rx, ry, rw, rh);
      ctx.setLineDash([]);
    }

    // Text overlay markers (text tab)
    if (tab === 'text') {
      const drawTextMarker = (cfg: TextOverlayConfig, label: string, color: string, active: boolean) => {
        const tx = cfg.x * scale;
        const ty = cfg.y * scale;
        ctx.save();
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = active ? 3 : 2;
        ctx.globalAlpha = active ? 1 : 0.85;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(tx - 10, ty);
        ctx.lineTo(tx + 130, ty);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(tx, ty - 8);
        ctx.lineTo(tx, ty + 8);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(tx, ty, active ? 8 : 6, 0, Math.PI * 2);
        ctx.fill();
        const fs = Math.max(11, 13 * scale);
        ctx.font = `bold ${fs}px sans-serif`;
        const tw = ctx.measureText(label).width;
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.beginPath();
        ctx.roundRect(tx + 12, ty - fs - 2, tw + 8, fs + 4, 3);
        ctx.fill();
        ctx.fillStyle = color;
        ctx.fillText(label, tx + 16, ty - 4);
        ctx.globalAlpha = 1;
        ctx.restore();
      };
      if (nameEnabled) drawTextMarker(nameCfg, 'NAME', '#facc15', draggingText === 'name');
      if (desigEnabled) drawTextMarker(desigCfg, 'DESIGNATION', '#4ade80', draggingText === 'designation');
    }
  }, [slots, selectedSlotIndex, photoSlot, scale, isDrawing, wordsDragMode, drawStart, drawCurrent, tab,
      nameEnabled, nameCfg, desigEnabled, desigCfg, draggingText,
      baseline, baselineDraft, draggingBaseline, baselineHover]);

  useEffect(() => { redrawCanvas(); }, [redrawCanvas]);

  // ── Baseline helpers (mirrors TemplateEditor.tsx, minus the snap-flash
  // visual — functional parity, not the animation polish) ─────────────────
  const snapBaselineToEdges = (b: Baseline): Baseline => {
    const W = config.dimensions.width, H = config.dimensions.height;
    const t = Math.max(8, Math.round(Math.min(W, H) * 0.02));
    const xT = [0, W, W / 2, W / 3, (2 * W) / 3, W / 4, (3 * W) / 4];
    const yT = [0, H, H / 2, H / 3, (2 * H) / 3, H / 4, (3 * H) / 4];
    const snap = (v: number, targets: number[]) => {
      let best = v, bestD = t;
      for (const tgt of targets) {
        const d = Math.abs(v - tgt);
        if (d < bestD) { bestD = d; best = Math.round(tgt); }
      }
      return best;
    };
    return { x1: snap(b.x1, xT), x2: snap(b.x2, xT), y: snap(b.y, yT) };
  };

  const hitTestBaseline = (imgX: number, imgY: number): 'move' | 'x1' | 'x2' | null => {
    if (!baseline) return null;
    const handleR = 11 / scale;
    const lineTol = 7 / scale;
    if (Math.hypot(imgX - baseline.x1, imgY - baseline.y) <= handleR) return 'x1';
    if (Math.hypot(imgX - baseline.x2, imgY - baseline.y) <= handleR) return 'x2';
    const lx = Math.min(baseline.x1, baseline.x2), rx = Math.max(baseline.x1, baseline.x2);
    if (imgX >= lx - lineTol && imgX <= rx + lineTol && Math.abs(imgY - baseline.y) <= lineTol) return 'move';
    return null;
  };

  // ── Mouse coords ────────────────────────────────────────────────────────
  const getImgCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) / scale, y: (e.clientY - rect.top) / scale };
  };

  const hitTestText = (x: number, y: number): 'name' | 'designation' | null => {
    const HIT = 20;
    if (nameEnabled && Math.abs(x - nameCfg.x) < HIT && Math.abs(y - nameCfg.y) < HIT) return 'name';
    if (desigEnabled && Math.abs(x - desigCfg.x) < HIT && Math.abs(y - desigCfg.y) < HIT) return 'designation';
    return null;
  };

  // ── Mouse handlers ──────────────────────────────────────────────────────
  const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = getImgCoords(e);

    if (tab === 'text') {
      const hit = hitTestText(c.x, c.y);
      if (hit) setDraggingText(hit);
      return;
    }

    if (tab === 'words') {
      // Priority 1: resize handle on the currently selected slot
      if (selectedSlotIndex !== null && slots[selectedSlotIndex]) {
        const sel = slots[selectedSlotIndex];
        const handle = getResizeHandleAt(c.x, c.y, sel, scale);
        if (handle) {
          const fx = (handle === 'nw' || handle === 'sw') ? sel.x + sel.width : sel.x;
          const fy = (handle === 'nw' || handle === 'ne') ? sel.y + sel.height : sel.y;
          setWordsDragMode('resize');
          setWordsDragIdx(selectedSlotIndex);
          setWordsDragFixed({ x: fx, y: fy });
          return;
        }
      }
      // Priority 2: move any slot under the cursor
      const hitIdx = getSlotAt(c.x, c.y, slots);
      if (hitIdx !== null) {
        setWordsDragMode('move');
        setWordsDragIdx(hitIdx);
        setSelectedSlotIndex(hitIdx);
        setWordsDragOffset({ x: c.x - slots[hitIdx].x, y: c.y - slots[hitIdx].y });
        return;
      }
      // Priority 3: if a slot is selected, deselect on empty-space click (no draw)
      if (selectedSlotIndex !== null) {
        setSelectedSlotIndex(null);
        return;
      }
      // Priority 4: draw a new slot on empty space (only when nothing is selected)
      if (slots.length < 6) {
        setWordsDragMode('draw');
        setDrawStart({ x: c.x * scale, y: c.y * scale });
        setDrawCurrent({ x: c.x * scale, y: c.y * scale });
      }
      return;
    } else {
      // Photo slot tab

      // Grab an existing baseline to move (line body) or resize (endpoint) —
      // works in any photo-tab mode, same as TemplateEditor.tsx, so you don't
      // have to switch to "Draw Baseline" just to nudge an already-placed one.
      if (baseline) {
        const hb = hitTestBaseline(c.x, c.y);
        if (hb) {
          baselineDragRef.current = { grabX: c.x, grabY: c.y, orig: { ...baseline } };
          setDraggingBaseline(hb);
          return;
        }
      }

      if (photoMode === 'baseline') {
        isDrawingBaseline.current = true;
        setBaselineDraft({ x1: Math.round(c.x), x2: Math.round(c.x), y: Math.round(c.y) });
      } else if (photoMode === 'draw') {
        setIsDrawing(true);
        setDrawStart({ x: c.x * scale, y: c.y * scale });
        setDrawCurrent({ x: c.x * scale, y: c.y * scale });
      } else if (photoMode === 'anchor' && photoSlot) {
        if (
          c.x >= photoSlot.x && c.x <= photoSlot.x + photoSlot.width &&
          c.y >= photoSlot.y && c.y <= photoSlot.y + photoSlot.height
        ) {
          const ax = (c.x - photoSlot.x) / photoSlot.width;
          const ay = (c.y - photoSlot.y) / photoSlot.height;
          setPhotoSlot(prev => prev ? { ...prev, anchor_x: ax, anchor_y: ay } : prev);
          setPhotoDirty(true);
        }
      }
    }
  };

  const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
    const c = getImgCoords(e);

    if (draggingText) {
      const nx = Math.round(Math.max(0, c.x));
      const ny = Math.round(Math.max(0, c.y));
      if (draggingText === 'name') setNameCfg(p => ({ ...p, x: nx, y: ny }));
      else setDesigCfg(p => ({ ...p, x: nx, y: ny }));
      setTextDirty(true);
      return;
    }

    // Move / resize a committed baseline (edge/thirds/center snapping applies).
    if (draggingBaseline && baselineDragRef.current) {
      const { grabX, grabY, orig } = baselineDragRef.current;
      let next: Baseline;
      if (draggingBaseline === 'move') {
        const dx = Math.round(c.x - grabX), dy = Math.round(c.y - grabY);
        const w = config.dimensions.width, h = config.dimensions.height;
        const minX = Math.min(orig.x1, orig.x2), maxX = Math.max(orig.x1, orig.x2);
        const clampedDx = Math.max(-minX, Math.min(w - maxX, dx));
        const clampedDy = Math.max(-orig.y, Math.min(h - orig.y, dy));
        next = { x1: orig.x1 + clampedDx, x2: orig.x2 + clampedDx, y: orig.y + clampedDy };
      } else {
        const nx = Math.round(Math.max(0, Math.min(config.dimensions.width, c.x)));
        next = draggingBaseline === 'x1' ? { ...orig, x1: nx } : { ...orig, x2: nx };
      }
      setBaseline(snapBaselineToEdges(next));
      setPhotoDirty(true);
      return;
    }

    // Draw a new baseline: Y stays locked to the mousedown row (always horizontal).
    if (isDrawingBaseline.current) {
      setBaselineDraft(prev => prev ? snapBaselineToEdges({ ...prev, x2: Math.round(c.x) }) : prev);
      return;
    }

    // Idle affordance: grab/resize cursor when hovering a baseline in the photo tab.
    if (tab === 'photo' && baseline && !isDrawing && wordsDragMode === 'none') {
      const hb = hitTestBaseline(c.x, c.y);
      setBaselineHover(prev => (prev === hb ? prev : hb));
    }

    // Words tab drag operations
    if (wordsDragMode === 'move' && wordsDragIdx !== null) {
      const s = slots[wordsDragIdx];
      const nx = Math.round(Math.max(0, Math.min(c.x - wordsDragOffset.x, config.dimensions.width - s.width)));
      const ny = Math.round(Math.max(0, Math.min(c.y - wordsDragOffset.y, config.dimensions.height - s.height)));
      setSlots(prev => prev.map((sl, i) => i === wordsDragIdx ? { ...sl, x: nx, y: ny } : sl));
      setWordsDirty(true);
      return;
    }

    if (wordsDragMode === 'resize' && wordsDragIdx !== null) {
      const newX = Math.round(Math.max(0, Math.min(wordsDragFixed.x, c.x)));
      const newY = Math.round(Math.max(0, Math.min(wordsDragFixed.y, c.y)));
      const newW = Math.max(20, Math.round(Math.abs(c.x - wordsDragFixed.x)));
      const newH = Math.max(20, Math.round(Math.abs(c.y - wordsDragFixed.y)));
      setSlots(prev => prev.map((sl, i) => i === wordsDragIdx ? { ...sl, x: newX, y: newY, width: newW, height: newH } : sl));
      setWordsDirty(true);
      return;
    }

    if (wordsDragMode === 'draw') {
      setDrawCurrent({ x: c.x * scale, y: c.y * scale });
      return;
    }

    // Update hover cursor when not dragging (words tab)
    if (tab === 'words') {
      if (selectedSlotIndex !== null && slots[selectedSlotIndex]) {
        const handle = getResizeHandleAt(c.x, c.y, slots[selectedSlotIndex], scale);
        if (handle) { setWordsCursor(handleToCursor(handle)); return; }
      }
      const hitIdx = getSlotAt(c.x, c.y, slots);
      setWordsCursor(hitIdx !== null ? 'move' : (slots.length < 6 ? CROSSHAIR_CURSOR : 'default'));
      return;
    }

    if (!isDrawing) return;
    setDrawCurrent({ x: c.x * scale, y: c.y * scale });
  };

  const handleMouseUp = () => {
    if (draggingText) {
      setDraggingText(null);
      return;
    }

    // Baseline edit release — normalise so x1 stays the left endpoint, re-snap.
    if (draggingBaseline) {
      setBaseline(b => b ? snapBaselineToEdges({ x1: Math.min(b.x1, b.x2), x2: Math.max(b.x1, b.x2), y: b.y }) : b);
      setDraggingBaseline(null);
      baselineDragRef.current = null;
      return;
    }

    // Baseline draw commit — discard if too short (an accidental click/tiny drag).
    if (isDrawingBaseline.current) {
      isDrawingBaseline.current = false;
      setBaselineDraft(draft => {
        if (draft && Math.abs(draft.x2 - draft.x1) > 20) {
          const lo = Math.min(draft.x1, draft.x2), hi = Math.max(draft.x1, draft.x2);
          setBaseline(snapBaselineToEdges({ x1: lo, x2: hi, y: draft.y }));
          // Drawing a baseline IS the intent to use it — the backend only
          // honours it when anchor_mode is 'baseline'.
          setPhotoSlot(prev => prev ? { ...prev, anchor_mode: 'baseline' } : prev);
          setPhotoDirty(true);
        }
        return null;
      });
      return;
    }

    // End words move/resize
    if (wordsDragMode === 'move' || wordsDragMode === 'resize') {
      setWordsDragMode('none');
      setWordsDragIdx(null);
      return;
    }

    // Commit words draw
    if (wordsDragMode === 'draw') {
      setWordsDragMode('none');
      const x = Math.min(drawStart.x, drawCurrent.x) / scale;
      const y = Math.min(drawStart.y, drawCurrent.y) / scale;
      const width = Math.abs(drawCurrent.x - drawStart.x) / scale;
      const height = Math.abs(drawCurrent.y - drawStart.y) / scale;
      if (width > 50 && height > 50) {
        const rx = Math.round(Math.max(0, x));
        const ry = Math.round(Math.max(0, y));
        const rw = Math.round(Math.min(width, config.dimensions.width - rx));
        const rh = Math.round(Math.min(height, config.dimensions.height - ry));
        const order = slots.length;
        setSlots(prev => [...prev, { id: `slot_${order}`, order, x: rx, y: ry, width: rw, height: rh, rotation: 0 }]);
        setSelectedSlotIndex(slots.length);
        setWordsDirty(true);
      }
      return;
    }

    // Photo tab draw commit
    if (!isDrawing) return;

    const x = Math.min(drawStart.x, drawCurrent.x) / scale;
    const y = Math.min(drawStart.y, drawCurrent.y) / scale;
    const width = Math.abs(drawCurrent.x - drawStart.x) / scale;
    const height = Math.abs(drawCurrent.y - drawStart.y) / scale;

    if (width > 50 && height > 50) {
      const rx = Math.round(Math.max(0, x));
      const ry = Math.round(Math.max(0, y));
      const rw = Math.round(Math.min(width, config.dimensions.width - rx));
      const rh = Math.round(Math.min(height, config.dimensions.height - ry));
      setPhotoSlot(prev => ({
        ...(prev ?? DEFAULT_PHOTO_SLOT),
        x: rx, y: ry, width: rw, height: rh,
      }));
      setPhotoMode('anchor');
      setPhotoDirty(true);
    }

    setIsDrawing(false);
  };

  // ── Word slot actions ───────────────────────────────────────────────────
  const handleDeleteWordSlot = (idx: number) => {
    setSlots(prev => prev.filter((_, i) => i !== idx).map((s, i) => ({ ...s, order: i, id: `slot_${i}` })));
    setSelectedSlotIndex(null);
    setWordsDirty(true);
  };

  const handleDuplicateWordSlot = (idx: number) => {
    if (slots.length >= 6) return;
    const src = slots[idx];
    // Offset so the copy is visibly distinct and immediately draggable into
    // place, clamped so it doesn't start off the template edge.
    const nx = Math.max(0, Math.min(config.dimensions.width - src.width, src.x + 24));
    const ny = Math.max(0, Math.min(config.dimensions.height - src.height, src.y + 24));
    setSlots(prev => {
      const next = [...prev, { ...src, x: nx, y: ny }];
      // Re-derive id/order from position, same as delete/move-up — ids are
      // always sequential slot_0..slot_N-1, never stable identities.
      return next.map((s, i) => ({ ...s, order: i, id: `slot_${i}` }));
    });
    setSelectedSlotIndex(slots.length);
    setWordsDirty(true);
  };

  const handleMoveUp = (idx: number) => {
    if (idx === 0) return;
    setSlots(prev => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next.map((s, i) => ({ ...s, order: i, id: `slot_${i}` }));
    });
    setSelectedSlotIndex(idx - 1);
    setWordsDirty(true);
  };

  // ── Save handlers ───────────────────────────────────────────────────────
  const handleSaveWords = async () => {
    if (slots.length === 0) { setWordsSaveError('Add at least one word slot before saving.'); return; }
    setWordsSaving(true); setWordsSaveError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/slots`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail?.message || 'Failed to save'); }
      setWordsDirty(false);
      onSaved();
      alert('Word slots saved!');
    } catch (err: any) { setWordsSaveError(err.message); }
    finally { setWordsSaving(false); }
  };

  const handleSavePhotoSlot = async () => {
    if (!photoSlot) { setPhotoSaveError('Draw a photo slot on the image first.'); return; }
    setPhotoSaving(true); setPhotoSaveError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/photo-slot`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo_slot: { ...photoSlot, baseline } }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail?.message || 'Failed to save'); }
      setPhotoDirty(false);
      onSaved();
      alert('Photo slot saved!');
    } catch (err: any) { setPhotoSaveError(err.message); }
    finally { setPhotoSaving(false); }
  };

  // ── Settings save ────────────────────────────────────────────────────────
  const handleSaveSettings = async () => {
    setSettingsSaving(true); setSettingsSaveError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/settings`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ allow_manual_positioning: allowManualPositioning, max_selections: maxSelections }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail?.message || 'Failed to save'); }
      setSettingsDirty(false);
      onSaved();
      alert('Settings saved!');
    } catch (err: any) { setSettingsSaveError(err.message); }
    finally { setSettingsSaving(false); }
  };

  // ── Text overlay save ────────────────────────────────────────────────────
  const handleSaveTextOverlay = async () => {
    setTextSaving(true); setTextSaveError(null);
    const put = async (field: 'name_text' | 'designation_text', enabled: boolean, cfg: TextOverlayConfig) => {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/text-overlay`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ field, config: enabled ? cfg : null }),
      });
      if (!res.ok) { const e = await res.json(); throw new Error(e.detail?.message ?? 'Save failed'); }
    };
    try {
      await put('name_text', nameEnabled, nameCfg);
      await put('designation_text', desigEnabled, desigCfg);
      setTextDirty(false);
      alert('Text overlays saved!');
    } catch (err: any) { setTextSaveError(err.message); }
    finally { setTextSaving(false); }
  };

  // Unsaved guard
  useEffect(() => {
    if (!wordsDirty && !photoDirty && !settingsDirty) return;
    const h = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [wordsDirty, photoDirty]);

  // Cursor style
  const canvasCursor =
    tab === 'text' ? (draggingText ? 'grabbing' : 'grab')
    : tab === 'settings' ? 'default'
    : tab === 'words' ? (wordsDragMode !== 'none' ? 'grabbing' : wordsCursor)
    : draggingBaseline === 'move' ? 'grabbing'
    : draggingBaseline ? 'ew-resize'
    : baselineHover === 'move' ? 'grab'
    : baselineHover ? 'ew-resize'
    : photoMode === 'baseline' ? CROSSHAIR_CURSOR
    : photoMode === 'draw' ? CROSSHAIR_CURSOR
    : photoMode === 'anchor' ? 'pointer'
    : 'default';

  return (
    <div className={styles.container}>
      {/* Tab bar */}
      <div className={styles.tabBar}>
        <button className={`${styles.tab} ${tab === 'words' ? styles.tabActive : ''}`} onClick={() => setTab('words')}>
          Word Slots {wordsDirty && <span className={styles.dirtyDot} />}
        </button>
        <button className={`${styles.tab} ${tab === 'photo' ? styles.tabActive : ''}`} onClick={() => { setTab('photo'); setPhotoMode(photoSlot ? 'anchor' : 'draw'); }}>
          Photo Slot {photoDirty && <span className={styles.dirtyDot} />}{photoSlot ? ' ✓' : ' ⚠️'}
        </button>
        <button className={`${styles.tab} ${tab === 'settings' ? styles.tabActive : ''}`} onClick={() => setTab('settings')}>
          ⚙️ Settings {settingsDirty && <span className={styles.dirtyDot} />}
        </button>
        <button className={`${styles.tab} ${tab === 'text' ? styles.tabActive : ''}`} onClick={() => setTab('text')}>
          💬 Text Overlays {textDirty && <span className={styles.dirtyDot} />}
        </button>
      </div>

      {/* Instructions */}
      <div className={styles.instructions}>
        {tab === 'words' && '💡 Click a slot to select it → drag to move, drag a corner handle to resize. Drag on empty space to draw a new slot, or ⧉ duplicate an existing one from the list (max 6).'}
        {tab === 'photo' && photoMode === 'draw' && '🖱️ Drag to draw the user photo slot rectangle.'}
        {tab === 'photo' && photoMode === 'anchor' && '🎯 Click inside the blue slot to reposition the face anchor point (yellow dot).'}
        {tab === 'photo' && photoMode === 'baseline' && '📏 Drag to draw a baseline · grab the line to move it / its ends to resize · snaps to edges/thirds/center.'}
        {tab === 'photo' && photoMode === 'select' && '👆 Switch to Draw, Anchor, or Baseline mode using the toolbar above.'}
        {tab === 'settings' && '⚙️ Configure template-level behaviour settings.'}
        {tab === 'text' && '💬 Enable overlays, then drag the yellow (NAME) or green (DESIGNATION) markers to position them.'}
      </div>

      <div className={styles.editorMain}>
        {/* Canvas */}
        <div className={styles.canvasColumn}>
          {tab === 'photo' && (
            <div className={styles.photoToolbar}>
              <button className={`${styles.toolBtn} ${photoMode === 'draw' ? styles.toolActive : ''}`} onClick={() => setPhotoMode('draw')}>✏️ Draw Slot</button>
              <button className={`${styles.toolBtn} ${photoMode === 'anchor' ? styles.toolActive : ''}`} onClick={() => setPhotoMode('anchor')} disabled={!photoSlot}>🎯 Set Anchor</button>
              <button className={`${styles.toolBtn} ${photoMode === 'baseline' ? styles.toolActive : ''}`} onClick={() => setPhotoMode('baseline')} disabled={!photoSlot}
                title="Draw the baseline: the subject's bottom sits on this line, centered on its midpoint, scaled to its length">
                📏 Draw Baseline
              </button>
              {baseline && (
                <button className={styles.toolBtnDanger} onClick={() => {
                  setBaseline(null); setPhotoDirty(true);
                  setPhotoSlot(prev => prev && prev.anchor_mode === 'baseline' ? { ...prev, anchor_mode: 'face_center' } : prev);
                }}>🗑️ Clear Baseline</button>
              )}
              {photoSlot && <button className={styles.toolBtnDanger} onClick={() => { setPhotoSlot(null); setBaseline(null); setPhotoDirty(true); setPhotoMode('draw'); }}>🗑️ Clear</button>}
            </div>
          )}
          <div className={styles.canvasWrapper}>
            <img
              ref={imageRef}
              className={styles.baseImage}
              src={`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/image`}
              alt="Base"
              onLoad={handleImageLoad}
            />
            <canvas
              ref={canvasRef}
              className={styles.canvas}
              style={{ cursor: canvasCursor }}
              onMouseDown={handleMouseDown}
              onMouseMove={handleMouseMove}
              onMouseUp={handleMouseUp}
              onMouseLeave={() => {
                setIsDrawing(false);
                if (wordsDragMode !== 'none') { setWordsDragMode('none'); setWordsDragIdx(null); }
                isDrawingBaseline.current = false;
                setBaselineDraft(null);
                setDraggingBaseline(null);
                baselineDragRef.current = null;
              }}
            />
          </div>
        </div>

        {/* Sidebar */}
        <div className={styles.sidebar}>
          {tab === 'words' && (
            <>
              <div className={styles.sidebarTitle}>
                <span>Word Slots</span>
                <span style={{ fontSize: '0.8rem', opacity: 0.6 }}>{slots.length}/6</span>
              </div>
              <div className={styles.slotList}>
                {slots.map((slot, i) => (
                  <div key={slot.id} className={`${styles.slotItem} ${selectedSlotIndex === i ? styles.selected : ''}`} onClick={() => setSelectedSlotIndex(i)}>
                    <div className={styles.slotHeader}>
                      <span className={styles.slotName}>Word {slot.order + 1}</span>
                      <div className={styles.slotControls}>
                        <button className={styles.controlBtn} onClick={e => { e.stopPropagation(); handleMoveUp(i); }}>↑</button>
                        <button className={styles.controlBtn} disabled={slots.length >= 6}
                          title={slots.length >= 6 ? 'Maximum 6 word slots' : 'Duplicate this slot'}
                          onClick={e => { e.stopPropagation(); handleDuplicateWordSlot(i); }}>⧉</button>
                        <button className={`${styles.controlBtn} ${styles.deleteBtn}`} onClick={e => { e.stopPropagation(); handleDeleteWordSlot(i); }}>🗑️</button>
                      </div>
                    </div>
                    <div className={styles.slotMeta}>
                      <span>X: {slot.x}px</span><span>Y: {slot.y}px</span>
                      <span>W: {slot.width}px</span><span>H: {slot.height}px</span>
                    </div>
                  </div>
                ))}
                {slots.length === 0 && <div className={styles.statusText}>No word slots yet. Drag on the image to add one.</div>}
              </div>

              {/* Rotation — always visible for the selected slot */}
              {selectedSlotIndex !== null && slots[selectedSlotIndex] && (() => {
                const sel = slots[selectedSlotIndex];
                return (
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>
                      Rotation — Word {sel.order + 1}: {sel.rotation ?? 0}°
                    </label>
                    <input
                      type="range" min="-45" max="45" step="1"
                      value={sel.rotation ?? 0}
                      className={styles.slider}
                      onChange={e => {
                        const rotation = parseInt(e.target.value);
                        setSlots(prev => prev.map((s, j) => j === selectedSlotIndex ? { ...s, rotation } : s));
                        setWordsDirty(true);
                      }}
                    />
                  </div>
                );
              })()}

              <div className={styles.saveArea}>
                {wordsSaveError && <div className={styles.error}>{wordsSaveError}</div>}
                <button className={styles.saveBtn} onClick={handleSaveWords} disabled={wordsSaving || !wordsDirty}>
                  {wordsSaving ? 'Saving...' : 'Save Word Slots'}
                </button>
                {wordsDirty && <div className={styles.statusText} style={{ color: '#f87171' }}>⚠️ Unsaved changes</div>}
              </div>
            </>
          )}

          {tab === 'photo' && (
            <>
              <div className={styles.sidebarTitle}>Photo Slot</div>

              {photoSlot ? (
                <>
                  <div className={`${styles.slotItem} ${styles.selected}`} style={{ borderColor: '#4f8ef7' }}>
                    <div className={styles.slotMeta}>
                      <span>X: {photoSlot.x}px</span><span>Y: {photoSlot.y}px</span>
                      <span>W: {photoSlot.width}px</span><span>H: {photoSlot.height}px</span>
                    </div>
                    <div className={styles.slotMeta} style={{ marginTop: '0.25rem' }}>
                      <span>Anchor X: {(photoSlot.anchor_x * 100).toFixed(0)}%</span>
                      <span>Anchor Y: {(photoSlot.anchor_y * 100).toFixed(0)}%</span>
                    </div>
                  </div>

                  {/* Anchor mode */}
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Anchor Mode</label>
                    <select
                      className={styles.settingSelect}
                      value={photoSlot.anchor_mode}
                      onChange={e => { setPhotoSlot(prev => prev ? { ...prev, anchor_mode: e.target.value as PhotoSlotDefinition['anchor_mode'] } : prev); setPhotoDirty(true); }}
                    >
                      <option value="baseline">Baseline (Robust auto-place) ⭐</option>
                      <option value="face_center">Face Center</option>
                      <option value="eyes">Eyes</option>
                      <option value="full_frame">Full Frame (Green screen)</option>
                      <option value="none">None (Bottom anchor)</option>
                    </select>
                  </div>

                  {photoSlot.anchor_mode === 'baseline' && (
                    <div className={styles.settingRow} style={{ background: 'rgba(34,211,238,0.1)', borderRadius: 6, padding: '8px 10px', flexDirection: 'column', alignItems: 'stretch', gap: 8 }}>
                      <span style={{ fontSize: '0.78rem', color: '#67e8f9' }}>
                        📏 Robust placement: the cutout is auto-scaled &amp; grounded on the baseline (no face detection).
                        {baseline ? ' Type exact values below, or drag the line with the Draw Baseline tool.' : ' Click "Draw Baseline" above, then drag a horizontal line where the subject should stand.'}
                      </span>
                      {baseline && (() => {
                        const clampX = (v: number) => Math.max(0, Math.min(config.dimensions.width, Math.round(v)));
                        const clampY = (v: number) => Math.max(0, Math.min(config.dimensions.height, Math.round(v)));
                        const numStyle: React.CSSProperties = { width: 72 };
                        return (
                          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: '#94a3b8' }}>
                              y
                              <input type="number" value={Math.round(baseline.y)} style={numStyle}
                                onChange={e => { setBaseline(b => b ? { ...b, y: clampY(+e.target.value || 0) } : b); setPhotoDirty(true); }} />
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: '#94a3b8' }}>
                              x1
                              <input type="number" value={Math.round(baseline.x1)} style={numStyle}
                                onChange={e => { setBaseline(b => b ? { ...b, x1: clampX(+e.target.value || 0) } : b); setPhotoDirty(true); }} />
                            </label>
                            <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: '0.75rem', color: '#94a3b8' }}>
                              x2
                              <input type="number" value={Math.round(baseline.x2)} style={numStyle}
                                onChange={e => { setBaseline(b => b ? { ...b, x2: clampX(+e.target.value || 0) } : b); setPhotoDirty(true); }} />
                            </label>
                            <span style={{ fontSize: '0.7rem', color: '#64748b', alignSelf: 'center' }}>
                              width {Math.abs(baseline.x2 - baseline.x1)}px
                            </span>
                          </div>
                        );
                      })()}
                    </div>
                  )}

                  {/* Face ratio */}
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>
                      Face Size: {(photoSlot.desired_face_ratio * 100).toFixed(0)}% of slot height
                    </label>
                    <input
                      type="range" min="0.15" max="0.6" step="0.05"
                      value={photoSlot.desired_face_ratio}
                      onChange={e => { setPhotoSlot(prev => prev ? { ...prev, desired_face_ratio: parseFloat(e.target.value) } : prev); setPhotoDirty(true); }}
                      className={styles.slider}
                    />
                  </div>

                  {/* Zoom range */}
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Zoom Range</label>
                    <div className={styles.zoomInputs}>
                      <input type="number" min="0.1" max="1" step="0.1"
                        value={photoSlot.min_zoom}
                        onChange={e => { setPhotoSlot(prev => prev ? { ...prev, min_zoom: parseFloat(e.target.value) } : prev); setPhotoDirty(true); }}
                        className={styles.zoomInput}
                      />
                      <span style={{ color: '#94a3b8' }}>to</span>
                      <input type="number" min="1" max="5" step="0.1"
                        value={photoSlot.max_zoom}
                        onChange={e => { setPhotoSlot(prev => prev ? { ...prev, max_zoom: parseFloat(e.target.value) } : prev); setPhotoDirty(true); }}
                        className={styles.zoomInput}
                      />
                    </div>
                  </div>

                  {/* Sticker filter */}
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Sticker Filter</label>
                    <select
                      className={styles.settingSelect}
                      value={photoSlot.sticker_filter ?? 'none'}
                      onChange={e => { setPhotoSlot(prev => prev ? { ...prev, sticker_filter: e.target.value as PhotoSlotDefinition['sticker_filter'] } : prev); setPhotoDirty(true); }}
                    >
                      <option value="none">None (colour)</option>
                      <option value="bw">Black &amp; White</option>
                      <option value="sketch">Pencil Sketch</option>
                    </select>
                  </div>
                </>
              ) : (
                <div className={styles.statusText}>No photo slot yet. Use Draw Slot above to define one.</div>
              )}

              <div className={styles.saveArea}>
                {photoSaveError && <div className={styles.error}>{photoSaveError}</div>}
                <button className={styles.saveBtn} onClick={handleSavePhotoSlot} disabled={photoSaving || !photoDirty}>
                  {photoSaving ? 'Saving...' : 'Save Photo Slot'}
                </button>
                {photoDirty && <div className={styles.statusText} style={{ color: '#f87171' }}>⚠️ Unsaved changes</div>}
              </div>
            </>
          )}

          {tab === 'settings' && (
            <>
              <div className={styles.sidebarTitle}>Template Settings</div>

              <div className={styles.settingRow}>
                <label className={styles.settingLabel}>
                  Max Word Selections: {maxSelections}
                </label>
                <input
                  type="range" min="1" max="6" step="1"
                  value={maxSelections}
                  onChange={e => { setMaxSelections(parseInt(e.target.value)); setSettingsDirty(true); }}
                  className={styles.slider}
                />
                <span style={{ fontSize: '0.75rem', color: '#64748b' }}>
                  How many words the guest can pick (must match your word slot count)
                </span>
              </div>

              <div className={styles.settingRow}>
                <label className={styles.settingLabel}>Allow Manual Positioning</label>
                <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={allowManualPositioning}
                    onChange={e => { setAllowManualPositioning(e.target.checked); setSettingsDirty(true); }}
                    style={{ width: 16, height: 16, accentColor: '#4f8ef7' }}
                  />
                  <span style={{ fontSize: '0.85rem', color: '#cbd5e1' }}>
                    Let guests drag and resize their cutout after capture
                  </span>
                </label>
              </div>

              <div className={styles.saveArea}>
                {settingsSaveError && <div className={styles.error}>{settingsSaveError}</div>}
                <button className={styles.saveBtn} onClick={handleSaveSettings} disabled={settingsSaving || !settingsDirty}>
                  {settingsSaving ? 'Saving...' : 'Save Settings'}
                </button>
                {settingsDirty && <div className={styles.statusText} style={{ color: '#f87171' }}>⚠️ Unsaved changes</div>}
              </div>
            </>
          )}

          {tab === 'text' && (
            <>
              <div className={styles.sidebarTitle}>Text Overlays</div>

              {/* NAME */}
              <div className={styles.settingRow}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={nameEnabled}
                    onChange={e => { setNameEnabled(e.target.checked); setTextDirty(true); }}
                    style={{ width: 15, height: 15, accentColor: '#facc15' }} />
                  <strong style={{ color: '#facc15' }}>Name Text</strong>
                </label>
              </div>
              {nameEnabled && (
                <div className={styles.slotItem} style={{ borderColor: '#facc1560', marginBottom: 8 }}>
                  <div className={styles.slotMeta}>
                    <span>X: {nameCfg.x}px</span><span>Y: {nameCfg.y}px</span>
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Font size</label>
                    <input type="number" value={nameCfg.font_size} style={{ width: 70 }}
                      onChange={e => { setNameCfg(p => ({ ...p, font_size: +e.target.value || 60 })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Color</label>
                    <input type="color" value={nameCfg.color}
                      onChange={e => { setNameCfg(p => ({ ...p, color: e.target.value })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Font</label>
                    <select className={styles.settingSelect} value={nameCfg.font_name}
                      onChange={e => { setNameCfg(p => ({ ...p, font_name: e.target.value })); setTextDirty(true); }}>
                      <option value="">Default</option>
                      {fonts.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Max width (0=none)</label>
                    <input type="number" value={nameCfg.max_width} style={{ width: 70 }}
                      onChange={e => { setNameCfg(p => ({ ...p, max_width: +e.target.value || 0 })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Align</label>
                    <select className={styles.settingSelect} value={nameCfg.align}
                      onChange={e => { setNameCfg(p => ({ ...p, align: e.target.value as TextOverlayConfig['align'] })); setTextDirty(true); }}>
                      <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={nameCfg.uppercase}
                        onChange={e => { setNameCfg(p => ({ ...p, uppercase: e.target.checked })); setTextDirty(true); }} />
                      <span className={styles.settingLabel}>Uppercase</span>
                    </label>
                  </div>
                </div>
              )}

              {/* DESIGNATION */}
              <div className={styles.settingRow}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                  <input type="checkbox" checked={desigEnabled}
                    onChange={e => { setDesigEnabled(e.target.checked); setTextDirty(true); }}
                    style={{ width: 15, height: 15, accentColor: '#4ade80' }} />
                  <strong style={{ color: '#4ade80' }}>Designation Text</strong>
                </label>
              </div>
              {desigEnabled && (
                <div className={styles.slotItem} style={{ borderColor: '#4ade8060', marginBottom: 8 }}>
                  <div className={styles.slotMeta}>
                    <span>X: {desigCfg.x}px</span><span>Y: {desigCfg.y}px</span>
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Font size</label>
                    <input type="number" value={desigCfg.font_size} style={{ width: 70 }}
                      onChange={e => { setDesigCfg(p => ({ ...p, font_size: +e.target.value || 40 })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Color</label>
                    <input type="color" value={desigCfg.color}
                      onChange={e => { setDesigCfg(p => ({ ...p, color: e.target.value })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Font</label>
                    <select className={styles.settingSelect} value={desigCfg.font_name}
                      onChange={e => { setDesigCfg(p => ({ ...p, font_name: e.target.value })); setTextDirty(true); }}>
                      <option value="">Default</option>
                      {fonts.map(f => <option key={f.name} value={f.name}>{f.name}</option>)}
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Max width (0=none)</label>
                    <input type="number" value={desigCfg.max_width} style={{ width: 70 }}
                      onChange={e => { setDesigCfg(p => ({ ...p, max_width: +e.target.value || 0 })); setTextDirty(true); }} />
                  </div>
                  <div className={styles.settingRow}>
                    <label className={styles.settingLabel}>Align</label>
                    <select className={styles.settingSelect} value={desigCfg.align}
                      onChange={e => { setDesigCfg(p => ({ ...p, align: e.target.value as TextOverlayConfig['align'] })); setTextDirty(true); }}>
                      <option value="left">Left</option><option value="center">Center</option><option value="right">Right</option>
                    </select>
                  </div>
                  <div className={styles.settingRow}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={desigCfg.uppercase}
                        onChange={e => { setDesigCfg(p => ({ ...p, uppercase: e.target.checked })); setTextDirty(true); }} />
                      <span className={styles.settingLabel}>Uppercase</span>
                    </label>
                  </div>
                </div>
              )}

              <div className={styles.saveArea}>
                {textSaveError && <div className={styles.error}>{textSaveError}</div>}
                <button className={styles.saveBtn} onClick={handleSaveTextOverlay} disabled={textSaving || !textDirty}>
                  {textSaving ? 'Saving…' : 'Save Text Overlays'}
                </button>
                {textDirty && <div className={styles.statusText} style={{ color: '#f87171' }}>⚠️ Unsaved changes</div>}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

export default WTMSlotEditor;
