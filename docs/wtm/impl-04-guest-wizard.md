# IMPL-04 — Guest Wizard: Word Selection + All Modified Screens

## Files to Create

- `frontend/hooks/useWordSelection.ts`
- `frontend/api/wtm.ts`
- `frontend/components/WordSelectionStep.tsx` + `WordSelectionStep.module.css`
- `frontend/components/WordGrid.tsx` + `WordGrid.module.css`
- `frontend/components/WordTile.tsx` + `WordTile.module.css`
- `frontend/components/BundleRow.tsx` + `BundleRow.module.css`
- `frontend/components/SelectionCounter.tsx` + `SelectionCounter.module.css`

## Files to Modify

- `frontend/app/page.tsx` — add WTM step + state (surgical, see below)
- `frontend/components/StepIndicator.tsx` — make steps dynamic
- `frontend/components/TemplateSelector.tsx` — add word_template support
- `frontend/components/screens/StartScreen.tsx` — add Word Template mode card
- `frontend/components/screens/TemplateScreen.tsx` — add word_template to type
- `frontend/components/index.ts` — add WordSelectionStep export

## DO NOT MODIFY

- CaptureScreen.tsx, PreviewEditScreen.tsx, PreviewScreen.tsx, ResultScreen.tsx
- Any existing session state keys in page.tsx
- Any existing step render blocks in page.tsx

## Prerequisite

IMPL-01, IMPL-02, IMPL-03 complete (or running parallel — types/wtm.ts needed).

---

## Modify: frontend/components/screens/StartScreen.tsx

The `onSelectMode` prop type and the mode cards need updating.

Change the interface:

```typescript
// FROM:
interface ModeSelectScreenProps {
  onSelectMode: (mode: "frame" | "sticker") => void;
}
// TO:
interface ModeSelectScreenProps {
  onSelectMode: (mode: "frame" | "sticker" | "word_template") => void;
}
```

Add a third card after the existing sticker card, following the exact same JSX pattern:

```tsx
<button
  className={styles.modeCard}
  onClick={() => onSelectMode("word_template")}
>
  <span className={styles.modeIcon}>🔤</span>
  <span className={styles.modeTitle}>Word Template</span>
  <span className={styles.modeDesc}>
    Choose words that appear on your doodle template
  </span>
</button>
```

Existing two cards are untouched.

---

## Modify: frontend/components/screens/TemplateScreen.tsx

Only the type changes:

```typescript
// FROM:
interface TemplateScreenProps {
  processingMode: 'frame' | 'sticker';
  ...
}
// TO:
interface TemplateScreenProps {
  processingMode: 'frame' | 'sticker' | 'word_template';
  ...
}
```

Nothing else changes in TemplateScreen.

---

## Modify: frontend/components/TemplateSelector.tsx

Three changes:

**1. Extend Template interface:**

```typescript
interface Template {
  templateId: string;
  name: string;
  templateType: "frame" | "sticker" | "word_template"; // add word_template
  slotCount: number;
  anchorMode: string;
}
```

**2. Extend processingMode prop type:**

```typescript
interface TemplateSelectorProps {
  selectedTemplate: string;
  onSelect: (templateId: string) => void;
  processingMode?: "frame" | "sticker" | "word_template"; // add word_template
}
```

**3. Fetch from correct endpoint when mode is word_template:**

```typescript
useEffect(() => {
  const fetchTemplates = async () => {
    try {
      if (processingMode === "word_template") {
        // Fetch from WTM admin endpoint — different shape, map to Template interface
        const response = await fetch(`${API_BASE_URL}/api/admin/wtm/templates`);
        const data: WTMTemplateListItem[] = await response.json();
        // Map snake_case WTM shape → camelCase Template shape for rendering
        setTemplates(
          data.map((t) => ({
            templateId: t.template_id,
            name: t.name,
            templateType: "word_template" as const,
            slotCount: t.slot_count,
            anchorMode: "none",
          })),
        );
      } else {
        // Existing frame/sticker fetch — UNTOUCHED
        const response = await fetch(`${API_BASE_URL}/api/templates`);
        const data = await response.json();
        setTemplates(data.templates || []);
      }
    } catch (error) {
      console.error("Failed to fetch templates:", error);
    } finally {
      setLoading(false);
    }
  };
  fetchTemplates();
}, [processingMode]);
```

Also add the import at top:

```typescript
import type { WTMTemplateListItem } from "@/types/wtm";
```

The existing filter logic (`filteredTemplates`) already works because WTM templates
now have templateType === 'word_template' and processingMode === 'word_template'.

Image preview for WTM templates:

```tsx
// In the templateCard img src, change to handle both endpoints:
src={
  template.templateType === 'word_template'
    ? `${API_BASE_URL}/api/admin/wtm/templates/${template.templateId}/image`
    : `${API_BASE_URL}/api/templates/${template.templateId}/image`
}
```

---

## Modify: frontend/components/StepIndicator.tsx

Make STEPS dynamic based on processingMode:

```typescript
// Change interface:
interface StepIndicatorProps {
  currentStep: number;
  processingMode?: "frame" | "sticker" | "word_template";
}

// Change STEPS from hardcoded const to computed:
const STEPS_DEFAULT = [
  { label: "Mode", icon: "🎨" },
  { label: "Template", icon: "🖼️" },
  { label: "Capture", icon: "📷" },
  { label: "Result", icon: "✨" },
];

const STEPS_WTM = [
  { label: "Mode", icon: "🎨" },
  { label: "Template", icon: "🖼️" },
  { label: "Words", icon: "🔤" },
  { label: "Capture", icon: "📷" },
  { label: "Result", icon: "✨" },
];

export default function StepIndicator({
  currentStep,
  processingMode,
}: StepIndicatorProps) {
  const STEPS = processingMode === "word_template" ? STEPS_WTM : STEPS_DEFAULT;
  // rest of render unchanged — just uses STEPS variable instead of hardcoded array
}
```

---

## Modify: frontend/app/page.tsx — Surgical Changes Only

**1. Extend ProcessingMode type:**

```typescript
// FROM:
type ProcessingMode = "frame" | "sticker";
// TO:
type ProcessingMode = "frame" | "sticker" | "word_template";
```

**2. Add two new session state fields** (after existing useSessionState calls):

```typescript
const [selectedWords, setSelectedWords] = useSessionState<string[]>(
  "selectedWords",
  [],
);
const [composedTemplatePath, setComposedTemplatePath] = useSessionState<
  string | null
>("composedTemplatePath", null);
```

**3. Add WordSelectionStep import:**

```typescript
import WordSelectionStep from "../components/WordSelectionStep";
```

**4. Update handleBack** to clear WTM state when going back from step 3 in WTM mode:

```typescript
const handleBack = useCallback(() => {
  // If going back from word selection step, clear WTM selections
  if (step === 3 && processingMode === "word_template") {
    setSelectedWords([]);
    setComposedTemplatePath(null);
  }
  setStep((prev: number) => Math.max(1, prev - 1));
  setError(null);
}, [step, processingMode, setStep, setSelectedWords, setComposedTemplatePath]);
```

**5. Add WTM word selection confirm handler:**

```typescript
const handleWordSelectionConfirm = useCallback(
  (composedPath: string) => {
    setComposedTemplatePath(composedPath);
    setStep(4); // advance to CaptureScreen (now step 4 in WTM mode)
  },
  [setComposedTemplatePath, setStep],
);
```

**6. Update handleStartOver** to also clear WTM state:

```typescript
// Add these two lines inside handleStartOver alongside existing clears:
setSelectedWords([]);
setComposedTemplatePath(null);
```

**7. Update StepIndicator** to receive processingMode:

```tsx
// FROM:
<StepIndicator currentStep={step} />
// TO:
<StepIndicator currentStep={step} processingMode={processingMode} />
```

**8. Add step 3 render block** for WTM word selection.
Insert BETWEEN the TemplateScreen block and the CaptureScreen block:

```tsx
{
  step === 3 && processingMode === "word_template" && (
    <WordSelectionStep
      templateId={selectedTemplate}
      onConfirm={handleWordSelectionConfirm}
      onBack={handleBack}
    />
  );
}
```

**9. Shift CaptureScreen render condition:**

```tsx
// FROM:
{step === 3 && !isEditing && (
// TO:
{(step === 4 || (step === 3 && processingMode !== 'word_template')) && !isEditing && (
```

**10. Shift PreviewEditScreen render condition:**

```tsx
// FROM:
{step === 3 && isEditing && rawImage && templateConfig && (
// TO:
{(step === 4 || (step === 3 && processingMode !== 'word_template')) && isEditing && rawImage && templateConfig && (
```

**11. Shift ResultScreen render condition:**

```tsx
// FROM:
{step === 4 && result && (
// TO:
{(processingMode === 'word_template' ? step === 5 : step === 4) && result && (
```

**12. Update executeGeneration for word_template mode:**
In `executeGeneration`, the `template_id` sent to `/api/generate` must be the
composed PNG path when in word_template mode. Check how `generate.py` handles
the `template_id` field — if it supports a file path directly, pass
`composedTemplatePath` as the template. Add this logic:

```typescript
// Inside executeGeneration, when building formData:
formData.append("template_id", selectedTemplate); // existing (frame/sticker)
if (pMode === "word_template" && composedTemplatePath) {
  // Override template with WTM composed PNG path
  formData.set("template_id", composedTemplatePath);
}
```

**IMPORTANT NOTE on step 12:** Before implementing, check `backend/api/generate.py`
to confirm exactly how it expects the template reference. If it uses `template_id`
as a file path lookup, pass `composedTemplatePath`. If it expects a different field,
use that field. Do NOT modify generate.py — only adjust what the frontend sends.

---

## frontend/api/wtm.ts — Implement Exactly

```typescript
import type { WordsPayload, ComposePayload, ComposeResult } from "@/types/wtm";

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";

export async function fetchWords(templateId: string): Promise<WordsPayload> {
  const res = await fetch(`${API_BASE_URL}/api/wtm/words/${templateId}`);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || "Failed to load words");
  }
  return res.json();
}

export async function composeTemplate(
  payload: ComposePayload,
): Promise<ComposeResult> {
  const res = await fetch(`${API_BASE_URL}/api/wtm/compose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail?.message || "Compose failed");
  }
  return res.json();
}
```

---

## frontend/hooks/useWordSelection.ts — Implement Exactly

```typescript
import { useState, useCallback } from "react";

export function useWordSelection(maxSelections: number, slotCount: number) {
  const [selected, setSelected] = useState<string[]>([]);

  // effectiveMax: user can't select more words than there are slots
  const effectiveMax = Math.min(maxSelections, slotCount);

  const toggle = useCallback(
    (wordId: string) => {
      setSelected((prev) => {
        if (prev.includes(wordId)) {
          return prev.filter((id) => id !== wordId); // always allow deselect
        }
        if (prev.length >= effectiveMax) {
          return prev; // at cap — do nothing
        }
        return [...prev, wordId];
      });
    },
    [effectiveMax],
  );

  const selectBundle = useCallback(
    (bundleWords: string[]) => {
      setSelected(bundleWords.slice(0, effectiveMax)); // truncate to effectiveMax
    },
    [effectiveMax],
  );

  const clearAll = useCallback(() => setSelected([]), []);

  return { selected, toggle, selectBundle, clearAll, effectiveMax };
}
```

---

## WordSelectionStep.tsx — Implement Exactly

### Props

```typescript
interface WordSelectionStepProps {
  templateId: string;
  onConfirm: (composedTemplatePath: string) => void;
  onBack: () => void;
}
```

### State

```typescript
const [fetchState, setFetchState] = useState<"loading" | "success" | "error">(
  "loading",
);
const [wordsPayload, setWordsPayload] = useState<WordsPayload | null>(null);
const [composeState, setComposeState] = useState<"idle" | "loading" | "error">(
  "idle",
);
const [composeError, setComposeError] = useState<string | null>(null);
```

### Full component

```tsx
export default function WordSelectionStep({
  templateId,
  onConfirm,
  onBack,
}: WordSelectionStepProps) {
  const [fetchState, setFetchState] = useState<"loading" | "success" | "error">(
    "loading",
  );
  const [wordsPayload, setWordsPayload] = useState<WordsPayload | null>(null);
  const [composeState, setComposeState] = useState<
    "idle" | "loading" | "error"
  >("idle");
  const [composeError, setComposeError] = useState<string | null>(null);

  const { selected, toggle, selectBundle, effectiveMax } = useWordSelection(
    wordsPayload?.max_selections ?? 6,
    wordsPayload?.slot_count ?? 6,
  );

  const loadWords = useCallback(async () => {
    setFetchState("loading");
    try {
      const data = await fetchWords(templateId);
      setWordsPayload(data);
      setFetchState("success");
    } catch {
      setFetchState("error");
    }
  }, [templateId]);

  useEffect(() => {
    loadWords();
  }, [loadWords]);

  const handleConfirm = async () => {
    if (selected.length === 0 || !wordsPayload) return;
    setComposeState("loading");
    setComposeError(null);
    try {
      const result = await composeTemplate({
        template_id: templateId,
        selected_words: selected,
      });
      onConfirm(result.template_path);
    } catch (e: any) {
      setComposeError(e.message || "Something went wrong. Please try again.");
      setComposeState("error");
    }
  };

  if (fetchState === "loading")
    return <div className={styles.loading}>Loading words...</div>;
  if (fetchState === "error")
    return (
      <div className={styles.error}>
        <p>Could not load words. Please try again.</p>
        <button onClick={loadWords}>Retry</button>
      </div>
    );
  if (!wordsPayload || wordsPayload.words.length === 0)
    return (
      <div className={styles.empty}>
        <p>No words available for this template.</p>
        <button onClick={onBack}>Back</button>
      </div>
    );

  return (
    <div className={styles.container}>
      <SelectionCounter selected={selected.length} max={effectiveMax} />
      {wordsPayload.bundles.length > 0 && (
        <BundleRow
          bundles={wordsPayload.bundles}
          selectedWords={selected}
          onSelectBundle={selectBundle}
        />
      )}
      <div
        style={{ pointerEvents: composeState === "loading" ? "none" : "auto" }}
      >
        <WordGrid
          words={wordsPayload.words}
          selectedIds={selected}
          effectiveMax={effectiveMax}
          onToggle={toggle}
        />
      </div>
      {composeState === "error" && composeError && (
        <div role="alert" className={styles.errorBanner}>
          {composeError}
        </div>
      )}
      <div className={styles.actions}>
        <button
          className={styles.backButton}
          onClick={onBack}
          disabled={composeState === "loading"}
        >
          ← Back
        </button>
        <button
          className={styles.confirmButton}
          onClick={handleConfirm}
          disabled={selected.length === 0 || composeState === "loading"}
          aria-disabled={selected.length === 0 || composeState === "loading"}
        >
          {composeState === "loading"
            ? "Creating your template..."
            : "Confirm →"}
        </button>
      </div>
    </div>
  );
}
```

---

## WordGrid.tsx, WordTile.tsx, BundleRow.tsx, SelectionCounter.tsx

### WordGrid

```typescript
interface WordGridProps {
  words: WordItem[];
  selectedIds: string[];
  effectiveMax: number;
  onToggle: (wordId: string) => void;
}
// Grid: 3 cols mobile, 4 cols tablet+
// isSelected = selectedIds.includes(word.id)
// isDisabled = !isSelected && selectedIds.length >= effectiveMax
// Renders one WordTile per word
```

### WordTile

```typescript
interface WordTileProps {
  word: WordItem;
  isSelected: boolean;
  isDisabled: boolean;
  onToggle: (wordId: string) => void;
}
// role="button", aria-pressed={isSelected}, aria-disabled={isDisabled}
// tabIndex={isDisabled ? -1 : 0}
// Min height: 56px. Large readable font.
// Selected: distinct bg, checkmark, transform: scale(1.04)
// Disabled: opacity 0.4, cursor not-allowed, no hover
// Label > 15 chars: truncate + title attribute
// NO internal state — all from props
```

### BundleRow

```typescript
interface BundleRowProps {
  bundles: BundleItem[];
  selectedWords: string[];
  onSelectBundle: (words: string[]) => void;
}
// One chip per bundle
// Highlighted if selectedWords contains exactly same IDs as bundle.words (order-independent)
// Tap → onSelectBundle(bundle.words) — replaces entire selection
// role="button", aria-label="Select {bundle.label} bundle"
```

### SelectionCounter

```typescript
interface SelectionCounterProps {
  selected: number;
  max: number;
}
// Renders: "{selected} / {max} selected"
// aria-live="polite" on container
// selected === max: green "full" style
// selected === 0: muted grey
// Always visible
```

---

## Modify: frontend/components/index.ts

Add:

```typescript
export { default as WordSelectionStep } from "./WordSelectionStep";
export { default as WordGrid } from "./WordGrid";
export { default as WordTile } from "./WordTile";
export { default as BundleRow } from "./BundleRow";
export { default as SelectionCounter } from "./SelectionCounter";
```

---

## Edge Cases

| Scenario                                | Handling                                                           |
| --------------------------------------- | ------------------------------------------------------------------ |
| Template has 3 slots                    | effectiveMax=3. Counter shows "X / 3". Cap enforced at 3.          |
| Bundle has more words than effectiveMax | selectBundle truncates to effectiveMax silently.                   |
| API returns 0 words                     | Show empty state + Back button only.                               |
| Compose fails on retry                  | Show error again. Keep selection. Do NOT clear.                    |
| Back from Word Selection                | Clear selectedWords + composedTemplatePath in page.tsx handleBack. |
| Template changed                        | page.tsx re-renders WordSelectionStep fresh. Selection cleared.    |
| Compose loading > 3s                    | Spinner continues. No frontend timeout. Trust backend 5s timeout.  |

---

## Required Tests

### useWordSelection

| Test                                 | Assert                                                |
| ------------------------------------ | ----------------------------------------------------- |
| `test_toggle_selects`                | toggle adds word to selected                          |
| `test_toggle_deselects`              | toggle on selected word removes it                    |
| `test_max_enforced`                  | at effectiveMax, toggling new word does nothing       |
| `test_deselect_works_at_max`         | at max, deselecting existing word works               |
| `test_select_bundle_replaces`        | selectBundle replaces entire selection                |
| `test_select_bundle_truncates`       | bundle with 8 words, effectiveMax=6 → only 6 selected |
| `test_effective_max_uses_slot_count` | slotCount=3, maxSelections=6 → effectiveMax=3         |

### WordSelectionStep

| Test                                        | Assert                                                    |
| ------------------------------------------- | --------------------------------------------------------- |
| `test_shows_loading_on_mount`               | Before fetchWords resolves → loading state shown          |
| `test_renders_grid_on_success`              | After fetch → WordTile elements present                   |
| `test_shows_error_on_fetch_fail`            | fetchWords throws → error + Retry button                  |
| `test_confirm_disabled_with_zero_selection` | 0 words → Confirm has aria-disabled                       |
| `test_confirm_calls_compose`                | Tap Confirm → composeTemplate called with correct payload |
| `test_onconfirm_called_on_success`          | Compose succeeds → onConfirm called with template_path    |
| `test_error_banner_on_compose_fail`         | Compose throws → error shown, selection preserved         |
| `test_back_disabled_during_compose`         | composeState=loading → Back button disabled               |
| `test_empty_words_shows_empty_state`        | words:[] → empty state, no grid                           |
