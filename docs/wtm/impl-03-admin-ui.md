# IMPL-03 — Admin UI: WTM Tab + Slot Editor + Word Manager + Bundle Manager

## Files to Create
- `frontend/types/wtm.ts`
- `frontend/components/WTMAdmin.tsx` + `WTMAdmin.module.css`
- `frontend/components/WTMSlotEditor.tsx` + `WTMSlotEditor.module.css`
- `frontend/components/WTMWordManager.tsx` + `WTMWordManager.module.css`
- `frontend/components/WTMBundleManager.tsx` + `WTMBundleManager.module.css`

## Files to Modify
- `frontend/app/admin/page.tsx` — add 4th tab only (surgical, see below)
- `frontend/components/index.ts` — add WTM exports

## ABSOLUTE RULES
1. DO NOT modify `TemplateEditor.tsx` in any way.
2. DO NOT modify any existing tab in `frontend/app/admin/page.tsx`.
3. DO NOT modify `backend/api/admin.py`.
4. Every new .tsx component MUST have a matching .module.css file.
5. All coordinate math in WTMSlotEditor follows the EXACT pattern from TemplateEditor.tsx:
   - `scale = canvas.width / image.naturalWidth` (set after image loads)
   - Stored coords are ALWAYS in original image pixels
   - Mouse → image pixels: divide by scale
   - Image pixels → display: multiply by scale
   - Minimum slot size: 50×50 image pixels (matches TemplateEditor's `width > 50 && height > 50`)

## Prerequisite
IMPL-01 and IMPL-02 complete. Backend endpoints live at /api/admin/wtm/*.

---

## Modify: frontend/app/admin/page.tsx — 4 lines only

```tsx
// 1. Extend the activeTab type (find existing useState for activeTab):
const [activeTab, setActiveTab] = useState<'stats' | 'templates' | 'gallery' | 'wtm'>('stats');

// 2. Add nav button after the Gallery button in the <nav>:
<button
  className={`${styles.navButton} ${activeTab === 'wtm' ? styles.active : ''}`}
  onClick={() => setActiveTab('wtm')}
>
  🔤 Word Templates
</button>

// 3. Add render block after the gallery block:
{activeTab === 'wtm' && (
  <WTMAdmin apiBaseUrl={API_BASE_URL} />
)}

// 4. Add import at top of file:
import WTMAdmin from '@/components/WTMAdmin';
```
That is ALL. No other changes to page.tsx.

---

## Modify: frontend/components/index.ts

Add these exports following the existing pattern:
```typescript
export { default as WTMAdmin } from './WTMAdmin';
export { default as WTMSlotEditor } from './WTMSlotEditor';
export { default as WTMWordManager } from './WTMWordManager';
export { default as WTMBundleManager } from './WTMBundleManager';
```

---

## frontend/types/wtm.ts — Implement Exactly

```typescript
// ── Guest-facing types ─────────────────────────────────────────────────

export interface WordItem {
  id: string;
  label: string;
  // svg_path deliberately omitted — frontend never needs server file paths
}

export interface BundleItem {
  id: string;
  label: string;
  words: string[];
}

export interface WordsPayload {
  template_id: string;
  words: WordItem[];
  bundles: BundleItem[];
  max_selections: number;
  slot_count: number;
}

export interface ComposePayload {
  template_id: string;
  selected_words: string[]; // frontend sends unsorted. Backend always sorts.
}

export interface ComposeResult {
  template_path: string;
  cache_hit: boolean;
  compose_time_ms?: number;
}

// ── Shared types ───────────────────────────────────────────────────────

export interface SlotDefinition {
  id: string;
  order: number;
  x: number;      // original image pixels
  y: number;      // original image pixels
  width: number;  // original image pixels
  height: number; // original image pixels
}

// ── Admin-only types ───────────────────────────────────────────────────

export interface WTMWord {
  id: string;
  label: string;
  svg_filename: string;
}

export interface WTMBundle {
  id: string;
  label: string;
  words: string[];
}

export interface WTMTemplateConfig {
  template_id: string;
  name: string;
  mode: 'word_template';
  base_image: string;
  dimensions: { width: number; height: number };
  slots: SlotDefinition[];
  words: WTMWord[];
  bundles: WTMBundle[];
  max_selections: number;
  created_at: string;
  updated_at: string;
}

export interface WTMTemplateListItem {
  template_id: string;
  name: string;
  slot_count: number;
  word_count: number;
  created_at: string;
}
```

---

## WTMAdmin.tsx — Top-level WTM admin component

### Props
```typescript
interface WTMAdminProps {
  apiBaseUrl: string;
}
```

### Internal views (not tabs — conditional render)
- `list` — template list + create new template form
- `slot-editor` — WTMSlotEditor for selected template
- `word-manager` — WTMWordManager + WTMBundleManager for selected template

### State
```typescript
const [view, setView] = useState<'list' | 'slot-editor' | 'word-manager'>('list');
const [templates, setTemplates] = useState<WTMTemplateListItem[]>([]);
const [selectedConfig, setSelectedConfig] = useState<WTMTemplateConfig | null>(null);
const [loading, setLoading] = useState(false);
const [createName, setCreateName] = useState('');
const [isCreating, setIsCreating] = useState(false);
const [error, setError] = useState<string | null>(null);
```

### Template list
- Fetch `GET {apiBaseUrl}/api/admin/wtm/templates` on mount.
- Each card shows: name, slot_count, word_count, created_at.
- "Edit Slots" button → fetch full config → setSelectedConfig → setView('slot-editor').
- "Edit Words" button → fetch full config → setSelectedConfig → setView('word-manager').
- "Delete" button → confirm dialog → DELETE → refresh list.

### Create form
- Name text input + PNG file picker (`accept=".png"`).
- Client-side: validate file.type === 'image/png' before submit.
- POST `{apiBaseUrl}/api/admin/wtm/templates` as multipart with `file` and `name` fields.
- On success: refresh list. Clear form.

### Load config helper
```typescript
const loadConfig = async (templateId: string): Promise<WTMTemplateConfig> => {
  const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${templateId}/config`);
  if (!res.ok) throw new Error('Failed to load config');
  return res.json();
};
```

### Back from editor/word-manager
- setView('list') → setSelectedConfig(null) → refresh list (config may have changed)

---

## WTMSlotEditor.tsx — Canvas slot drawing

### Props
```typescript
interface WTMSlotEditorProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onSaved: () => void;
  onBack: () => void;
}
```

### CRITICAL — Coordinate handling (matches TemplateEditor.tsx exactly)
```typescript
// After image loads — same as TemplateEditor's scale computation:
const handleImageLoad = () => {
  if (!canvasRef.current || !imageRef.current) return;
  const img = imageRef.current;
  // Scale canvas to match displayed image size
  canvasRef.current.width = img.clientWidth;
  canvasRef.current.height = img.clientHeight;
  setScale(img.clientWidth / img.naturalWidth);
};

// Mouse → image pixels (identical to TemplateEditor's getImageCoords):
const getImageCoords = (e: React.MouseEvent<HTMLCanvasElement>) => {
  const canvas = canvasRef.current!;
  const rect = canvas.getBoundingClientRect();
  return {
    x: (e.clientX - rect.left) / scale,
    y: (e.clientY - rect.top) / scale,
  };
};
```

### Single canvas — same pattern as TemplateEditor
Use one `<canvas>` ref. Draw everything in `redrawCanvas()`:
```typescript
const redrawCanvas = useCallback(() => {
  const canvas = canvasRef.current;
  const ctx = canvas?.getContext('2d');
  const img = imageRef.current;
  if (!canvas || !ctx || !img) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

  slots.forEach((slot, index) => {
    const isSelected = index === selectedSlotIndex;
    ctx.strokeStyle = isSelected ? '#00ff00' : '#ff6b6b'; // same as TemplateEditor
    ctx.lineWidth = isSelected ? 3 : 2;
    ctx.setLineDash([5, 5]);
    ctx.strokeRect(slot.x * scale, slot.y * scale, slot.width * scale, slot.height * scale);
    ctx.setLineDash([]);
    ctx.fillStyle = isSelected ? 'rgba(0,255,0,0.1)' : 'rgba(255,107,107,0.1)';
    ctx.fillRect(slot.x * scale, slot.y * scale, slot.width * scale, slot.height * scale);
    ctx.fillStyle = isSelected ? '#00ff00' : '#ff6b6b';
    ctx.font = 'bold 14px sans-serif';
    ctx.fillText(`Word ${slot.order + 1}`, slot.x * scale + 5, slot.y * scale + 18);
  });

  // In-progress draw rectangle
  if (isDrawing) {
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
}, [slots, selectedSlotIndex, scale, isDrawing, drawStart, drawCurrent]);
```

### Mouse handlers (identical pattern to TemplateEditor)
```typescript
const handleMouseDown = (e: React.MouseEvent<HTMLCanvasElement>) => {
  const coords = getImageCoords(e);
  setIsDrawing(true);
  // Store in DISPLAY pixels (same as TemplateEditor)
  setDrawStart({ x: coords.x * scale, y: coords.y * scale });
  setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
};

const handleMouseMove = (e: React.MouseEvent<HTMLCanvasElement>) => {
  if (!isDrawing) return;
  const coords = getImageCoords(e);
  setDrawCurrent({ x: coords.x * scale, y: coords.y * scale });
};

const handleMouseUp = () => {
  if (!isDrawing) return;
  // Convert display pixels → image pixels (same as TemplateEditor)
  const x = Math.min(drawStart.x, drawCurrent.x) / scale;
  const y = Math.min(drawStart.y, drawCurrent.y) / scale;
  const width = Math.abs(drawCurrent.x - drawStart.x) / scale;
  const height = Math.abs(drawCurrent.y - drawStart.y) / scale;

  // 50x50 minimum — matches TemplateEditor's (width > 50 && height > 50)
  if (width > 50 && height > 50) {
    const nextOrder = slots.length;
    const newSlot: SlotDefinition = {
      id: `slot_${nextOrder}`,
      order: nextOrder,
      x: Math.round(Math.max(0, x)),
      y: Math.round(Math.max(0, y)),
      width: Math.round(Math.min(width, config.dimensions.width - Math.round(x))),
      height: Math.round(Math.min(height, config.dimensions.height - Math.round(y))),
    };
    setSlots(prev => [...prev, newSlot]);
    setSelectedSlotIndex(slots.length);
  }
  setIsDrawing(false);
};
```

### Slot delete + reorder
```typescript
const handleDeleteSlot = (slotId: string) => {
  setSlots(prev => {
    const filtered = prev.filter(s => s.id !== slotId);
    // Re-index after deletion
    return filtered.map((s, i) => ({ ...s, order: i, id: `slot_${i}` }));
  });
  setSelectedSlotIndex(null);
  setIsDirty(true);
};

const handleMoveUp = (slotId: string) => {
  setSlots(prev => {
    const idx = prev.findIndex(s => s.id === slotId);
    if (idx <= 0) return prev;
    const next = [...prev];
    [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
    return next.map((s, i) => ({ ...s, order: i, id: `slot_${i}` }));
  });
  setIsDirty(true);
};
```

### Save
```typescript
const handleSave = async () => {
  if (slots.length === 0) { setSaveError('Add at least one slot before saving.'); return; }
  if (slots.length > 6) { setSaveError('Maximum 6 slots allowed.'); return; }
  setIsSaving(true);
  try {
    const res = await fetch(
      `${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/slots`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slots }) }
    );
    if (!res.ok) { const e = await res.json(); throw new Error(e.detail?.message || 'Save failed'); }
    setIsDirty(false);
    onSaved();
  } catch (e: any) { setSaveError(e.message); }
  finally { setIsSaving(false); }
};
```

### Unsaved changes guard
```typescript
useEffect(() => {
  if (!isDirty) return;
  const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
  window.addEventListener('beforeunload', handler);
  return () => window.removeEventListener('beforeunload', handler);
}, [isDirty]);
```

---

## WTMWordManager.tsx — Word list + SVG upload

### Props
```typescript
interface WTMWordManagerProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onConfigUpdated: (newConfig: WTMTemplateConfig) => void;
}
```

### Add word form
Fields:
- `word_id` input: `placeholder="e.g. champion"` — validate `^[a-z0-9-]+$` client-side
- `label` input: `placeholder="e.g. Champion"`
- SVG file picker: `accept=".svg"` — validate `.endsWith('.svg')` client-side

On submit:
```typescript
const formData = new FormData();
formData.append('word_id', wordId);
formData.append('label', label);
formData.append('file', svgFile);
await fetch(
  `${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words`,
  { method: 'POST', body: formData }
);
// On success: reload config, call onConfigUpdated, clear form
```

### Word list
For each word: show label + id + SVG preview + Delete button.
```tsx
<img
  src={`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words/${word.id}/svg`}
  style={{ height: '40px' }}
  alt={word.label}
/>
```
On delete: confirm → `DELETE /api/admin/wtm/templates/{id}/words/{word_id}` → reload config.

### After any change: reload config and call onConfigUpdated
```typescript
const reloadConfig = async () => {
  const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/config`);
  const newConfig = await res.json();
  onConfigUpdated(newConfig);
};
```

---

## WTMBundleManager.tsx — Bundle management

### Props
```typescript
interface WTMBundleManagerProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onConfigUpdated: (newConfig: WTMTemplateConfig) => void;
}
```

### State
```typescript
const [bundles, setBundles] = useState<WTMBundle[]>(config.bundles);
const [isDirty, setIsDirty] = useState(false);
const [newBundleLabel, setNewBundleLabel] = useState('');
const [newBundleWords, setNewBundleWords] = useState<string[]>([]);
```

### Add bundle
- Label input + checklist of all config.words (max 6 checked).
- On add: push to local bundles state. Set isDirty. Do NOT save yet.
- Generate bundle id from label: `label.toLowerCase().replace(/\s+/g, '_')`.

### Bundle list
- Show label + word chips (look up label from config.words).
- Delete removes from local state + sets isDirty.

### Save all bundles (single button)
```typescript
const handleSave = async () => {
  const res = await fetch(
    `${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/bundles`,
    { method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bundles }) }
  );
  if (!res.ok) throw new Error('Save failed');
  setIsDirty(false);
  // Reload config and call onConfigUpdated
};
```

---

## Edge Cases

| Scenario | Handling |
|----------|---------|
| Draw slot < 50×50 image pixels | Discard silently in handleMouseUp (matches TemplateEditor) |
| Draw outside image bounds | Clamp in handleMouseUp |
| Upload non-PNG base image | Client: check file.type === 'image/png'. Server also rejects. |
| Upload non-SVG word file | Client: check file.name.endsWith('.svg'). Server also rejects. |
| Duplicate word_id | Server returns 400. Show error inline. |
| Delete word in a bundle | Backend removes from bundles automatically. Frontend reloads config. |
| Save 0 slots | Show inline error. API call not made. |
| Template has 0 words | WTMBundleManager shows: "Add words first before creating bundles." |
| Window resize | Recompute scale, redraw canvas. Do NOT change stored pixel coords. |

---

## Required Tests

| Test | What to assert |
|------|---------------|
| `test_slot_coords_in_image_pixels` | Draw at 50% scale → stored x/y/w/h are 2× display values |
| `test_slot_clamped_to_image_bounds` | Drag beyond image edge → x+width <= dimensions.width |
| `test_small_slot_discarded` | Draw 30×30 display pixels at scale 1.0 → not added |
| `test_reorder_reindexes` | Move slot up → all IDs and orders re-indexed sequentially |
| `test_delete_reindexes` | Delete middle slot → remaining re-indexed 0,1,2... |
| `test_save_zero_slots_shows_error` | handleSave with empty slots → error shown, fetch not called |
| `test_word_form_validates_id_format` | word_id with uppercase → client error before submit |
| `test_word_form_validates_svg_extension` | Upload .png file → client error before submit |
| `test_bundle_max_six_words` | Attempt to check 7th word → 7th checkbox disabled |
