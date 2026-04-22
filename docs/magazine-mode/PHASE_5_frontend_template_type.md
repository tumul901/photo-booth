# Phase 5 — Frontend: Expose compositeMode from API + Thread to page.tsx

## Goal
The frontend wizard needs to know whether the selected template is a magazine
template so it can insert the Name + Designation step (Phase 6). This phase
makes `compositeMode` available in the frontend by:

1. Including `compositeMode` in the `/api/templates` list response
2. Updating `TemplateSelector` to pass `compositeMode` through its selection flow
3. Updating `TemplateScreen` to forward `compositeMode` upward
4. Storing `selectedTemplateMode` in `page.tsx` session state
5. Fixing template filtering so magazine templates are visible under sticker mode

**Files changed:**
- `backend/api/generate.py` — `/api/templates` route
- `frontend/components/TemplateSelector.tsx` — template data type + selection handler
- `frontend/components/screens/TemplateScreen.tsx` — onSelect prop signature
- `frontend/app/page.tsx` — session state + handler

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| `GET /api/templates` endpoint | ✅ exists in generate.py (~line 323) |
| `compositeMode` in template JSON | ✅ already stored |
| `templateType` in `/api/templates` response | ✅ already returned |
| `compositeMode` in `/api/templates` response | ❌ not currently included |
| `TemplateSelector` component | ✅ exists, handles template fetching + rendering |
| `TemplateScreen` component | ✅ exists, wraps TemplateSelector |
| `selectedTemplate` in page.tsx sessionState | ✅ exists |
| `selectedTemplateMode` in page.tsx | ❌ does not exist |

---

## Change 1 — Backend: Include `compositeMode` in template list

### File: `backend/api/generate.py`

Find the `list_templates()` function (~line 323). The current `templates.append`
dict is:

```python
templates.append({
    "templateId": meta.template_id,
    "name": meta.name,
    "templateType": meta.template_type,
    "slotCount": len(meta.slots),
    "anchorMode": meta.anchor_mode,
})
```

Change it to:

```python
templates.append({
    "templateId": meta.template_id,
    "name": meta.name,
    "templateType": meta.template_type,
    "compositeMode": meta.composite_mode,    # NEW
    "slotCount": len(meta.slots),
    "anchorMode": meta.anchor_mode,
})
```

`meta.composite_mode` is already on `TemplateMetadata` and set by
`load_template_metadata()`. This is a one-field addition.

---

## Change 2 — Frontend TemplateSelector: add compositeMode to data + selection

### File: `frontend/components/TemplateSelector.tsx`

This is the component that actually fetches templates and fires `onSelect` on
click. It must be updated to carry `compositeMode` through the selection flow.

#### 2a. Update the `Template` interface

Current (~line 15):

```typescript
interface Template {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker' | 'word_template';
  slotCount: number;
  anchorMode: string;
}
```

Change to:

```typescript
interface Template {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker' | 'word_template' | 'magazine';
  compositeMode: string;   // NEW — "overlay", "background", or "magazine"
  slotCount: number;
  anchorMode: string;
}
```

#### 2b. Update the `onSelect` prop type

Current (~line 26):

```typescript
interface TemplateSelectorProps {
  selectedTemplate: string;
  onSelect: (templateId: string) => void;
  processingMode?: 'frame' | 'sticker' | 'word_template';
}
```

Change to:

```typescript
interface TemplateSelectorProps {
  selectedTemplate: string;
  onSelect: (templateId: string, compositeMode: string) => void;  // CHANGED
  processingMode?: 'frame' | 'sticker' | 'word_template';
}
```

#### 2c. Fix the template filter to include magazine templates under sticker mode

Current filter logic (~line 70):

```typescript
const filteredTemplates = useMemo(() => {
  return templates.filter(t => t.templateType === processingMode);
}, [templates, processingMode]);
```

Change to:

```typescript
const filteredTemplates = useMemo(() => {
  if (processingMode === 'sticker') {
    // Magazine templates use the sticker pipeline (rembg + face detect + compose)
    // so they appear alongside regular sticker templates
    return templates.filter(t => t.templateType === 'sticker' || t.templateType === 'magazine');
  }
  return templates.filter(t => t.templateType === processingMode);
}, [templates, processingMode]);
```

**Why**: Magazine templates have `templateType: "magazine"` but use the same
processing pipeline as stickers (rembg → face detect → compose). Without this
fix, magazine templates would be invisible to users — there is no "magazine"
processing mode on the Start Screen.

#### 2d. Update the click handler to pass compositeMode

Current (~line 101):

```tsx
onClick={() => onSelect(template.templateId)}
```

Change to:

```tsx
onClick={() => onSelect(template.templateId, template.compositeMode)}
```

---

## Change 3 — Frontend TemplateScreen: forward compositeMode

### File: `frontend/components/screens/TemplateScreen.tsx`

#### 3a. Update the props interface

Current (~line 13):

```typescript
interface TemplateScreenProps {
  selectedTemplate: string;
  processingMode: 'frame' | 'sticker' | 'word_template';
  onSelect: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}
```

Change `onSelect` to also pass compositeMode:

```typescript
interface TemplateScreenProps {
  selectedTemplate: string;
  processingMode: 'frame' | 'sticker' | 'word_template';
  onSelect: (id: string, compositeMode: string) => void;  // CHANGED
  onNext: () => void;
  onBack: () => void;
}
```

No other change needed in TemplateScreen — it already forwards `onSelect`
directly to `TemplateSelector` (line 39), and `TemplateSelector` now calls it with
both args (Change 2d).

---

## Change 4 — page.tsx: Store selectedTemplateMode

### File: `frontend/app/page.tsx`

#### 4a. Add sessionState for compositeMode

After the existing `useSessionState` declarations (around line 100-103), add:

```typescript
const [selectedTemplateMode, setSelectedTemplateMode] =
  useSessionState<string>('selectedTemplateMode', '');
```

#### 4b. Update `handleTemplateSelect`

Currently (~line 119):

```typescript
const handleTemplateSelect = useCallback((id: string) => {
  setSelectedTemplate(id);
}, [setSelectedTemplate]);
```

Change to:

```typescript
const handleTemplateSelect = useCallback((id: string, compositeMode: string) => {
  setSelectedTemplate(id);
  setSelectedTemplateMode(compositeMode);
}, [setSelectedTemplate, setSelectedTemplateMode]);
```

#### 4c. Update `handleStartOver` to clear selectedTemplateMode

Find `handleStartOver` and add:

```typescript
setSelectedTemplateMode('');
```

alongside the existing resets.

#### 4d. Derive `isMagazineTemplate` as a constant

Add this immediately after the state declarations (around line 110), before the
handlers:

```typescript
// True when the selected template uses magazine composite mode
const isMagazineTemplate = selectedTemplateMode === 'magazine';
```

This boolean is used in Phase 7 to conditionally route through the name step.

---

## No UI Change in This Phase

This phase is plumbing only. The wizard flow does not change yet (that is
Phase 7). The `isMagazineTemplate` flag just becomes available.

---

## Test Checklist (manual)

1. `GET /api/templates` — verify each template object now includes
   `compositeMode` (e.g. `"magazine"` for magazine templates, `"overlay"` for
   frame templates).
2. In the running frontend, select "Remove BG" mode — verify **magazine templates
   appear alongside regular sticker templates** in the template grid.
3. Select a magazine template. Open React DevTools or add a
   `console.log(selectedTemplateMode)` — verify it prints `"magazine"`.
4. Select a non-magazine sticker template. Verify `selectedTemplateMode` is
   `"background"`, not `"magazine"`.
5. Select a frame template. Verify magazine templates do NOT appear in the grid.
6. Refresh the page mid-session with a magazine template selected — verify
   `selectedTemplateMode` is restored from sessionStorage (because it uses
   `useSessionState`).

---

## What This Phase Does NOT Do

- Does not show the Name + Designation screen (Phase 6 + 7)
- Does not change any generation API call (Phase 7)
- Does not modify the admin panel
