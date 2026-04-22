# Phase 7 — Frontend: Wizard Integration & API Wiring

## Goal
Wire the `MagazineNameScreen` (Phase 6) into the existing wizard flow in
`page.tsx`, manage the name + designation in session state, and send them to
`/api/generate` when the photo is submitted. This is the final integration phase
that makes the full magazine user flow functional end-to-end.

**Only file changed: `frontend/app/page.tsx`**

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| Multi-step wizard in page.tsx | ✅ steps 1-4 (or 3-5 for WTM) |
| `isMagazineTemplate` flag | ✅ added in Phase 5 |
| `MagazineNameScreen` component | ✅ built in Phase 6 |
| `executeGeneration()` function | ✅ exists, builds FormData and POSTs |
| `magazine_name` / `magazine_designation` form params on backend | ✅ added in Phase 2 |

---

## Understanding the Current Step Layout

Before making changes, here's how steps work **right now** for each mode:

| Step | Normal (frame/sticker) | WTM (word_template) |
|------|------------------------|---------------------|
| 1 | Mode Select | Mode Select |
| 2 | Template Select | Template Select |
| 3 | Capture | Word Selection |
| 4 | Result | Capture |
| 5 | — | Result |

The current JSX uses compound conditions to handle this:
```tsx
// Capture: step 3 for non-WTM, step 4 for WTM
{(step === 4 || (step === 3 && processingMode !== 'word_template')) && ...}

// Result: step 4 for non-WTM, step 5 for WTM
{(processingMode === 'word_template' ? step === 5 : step === 4) && ...}
```

**With magazine mode added**, the layout becomes:

| Step | Normal | WTM | Magazine |
|------|--------|-----|----------|
| 1 | Mode Select | Mode Select | Mode Select |
| 2 | Template Select | Template Select | Template Select |
| 3 | Capture | Word Selection | Name + Designation |
| 4 | Result | Capture | Capture |
| 5 | — | Result | Result |

Key insight: **Magazine mode has the same step offset as WTM** — both insert an
extra step at position 3. This simplifies the implementation.

---

## Changes Required

### File: `frontend/app/page.tsx`

#### 1. Import `MagazineNameScreen`

At the top of the file with the other component imports:

```typescript
import MagazineNameScreen from '../components/screens/MagazineNameScreen';
```

#### 2. Add sessionState for name + designation

After the existing `useSessionState` declarations (around line 100-105):

```typescript
const [magazineName, setMagazineName] =
  useSessionState<string>('magazineName', '');
const [magazineDesignation, setMagazineDesignation] =
  useSessionState<string>('magazineDesignation', '');
```

#### 3. Derive helper booleans and step constants

Right after the `isMagazineTemplate` constant (added in Phase 5):

```typescript
// Both WTM and magazine insert an extra step at position 3
// This shifts capture to step 4 and result to step 5
const hasExtraStep = processingMode === 'word_template' || isMagazineTemplate;
const captureStep = hasExtraStep ? 4 : 3;
const resultStep  = hasExtraStep ? 5 : 4;
```

#### 4. Add handler for name screen confirmation

Add after `handleTemplateNext`:

```typescript
const handleMagazineNameConfirm = useCallback(
  (name: string, designation: string) => {
    setMagazineName(name);
    setMagazineDesignation(designation);
    setStep(captureStep); // Jump to capture step (4)
  },
  [setMagazineName, setMagazineDesignation, setStep, captureStep]
);
```

#### 5. `handleTemplateNext` — No Change Needed

Currently it calls `setStep(3)`. For magazine templates, step 3 is the name
screen. For non-magazine, step 3 is capture. The JSX render logic (below)
handles which component shows at step 3. No change needed here.

#### 6. Update `handleBack` to handle magazine steps correctly

Current `handleBack` (around line 127):

```typescript
const handleBack = useCallback(() => {
  if (step === 3 && processingMode === 'word_template') {
    setSelectedWords([]);
    setComposedTemplatePath(null);
  }
  setStep((prev: number) => Math.max(1, prev - 1));
  setError(null);
}, [step, processingMode, setStep, setSelectedWords, setComposedTemplatePath]);
```

Replace with:

```typescript
const handleBack = useCallback(() => {
  // WTM: clear word selections when stepping back from word selection screen
  if (step === 3 && processingMode === 'word_template') {
    setSelectedWords([]);
    setComposedTemplatePath(null);
  }
  // Magazine: clear name/designation when stepping back FROM name screen TO templates
  if (step === 3 && isMagazineTemplate) {
    setMagazineName('');
    setMagazineDesignation('');
  }
  // Note: stepping back from capture (step 4) to name screen (step 3)
  // does NOT clear values — they stay pre-filled so user doesn't re-type.
  setStep((prev: number) => Math.max(1, prev - 1));
  setError(null);
}, [
  step, processingMode, isMagazineTemplate,
  setStep, setSelectedWords, setComposedTemplatePath,
  setMagazineName, setMagazineDesignation
]);
```

#### 7. Update `handleStartOver` to reset magazine state

In the existing `handleStartOver`, add:

```typescript
setMagazineName('');
setMagazineDesignation('');
setSelectedTemplateMode('');
```

alongside the other resets.

#### 8. Update `executeGeneration` to send name + designation

The current `executeGeneration` signature (line 169):

```typescript
const executeGeneration = async (imageData: string, pMode: string, positionData?: any) => {
```

**Option A — Closure approach** (simpler, works because `executeGeneration` is not
wrapped in `useCallback` so it always reads fresh state):

Inside the section that builds `formData`, after the existing `formData.append`
calls, add:

```typescript
// Magazine mode: send name and designation
if (isMagazineTemplate && magazineName) {
  formData.append('magazine_name', magazineName);
  formData.append('magazine_designation', magazineDesignation);
}
```

**Option B — Parameter approach** (safer if refactored to `useCallback` later):

Add optional params to the function signature:

```typescript
const executeGeneration = async (
  imageData: string,
  pMode: string,
  positionData?: any,
  magName: string = '',
  magDesignation: string = '',
) => {
```

And append them:
```typescript
if (magName) formData.append('magazine_name', magName);
if (magDesignation) formData.append('magazine_designation', magDesignation);
```

Then update all call sites:
```typescript
// In handleImageCapture:
executeGeneration(imageData, processingMode, undefined, magazineName, magazineDesignation);

// In handleEditComplete:
executeGeneration(extractedBase64, "pre_extracted", position, magazineName, magazineDesignation);
```

**Recommended: Use Option A** for simplicity. `executeGeneration` is a plain
`async function` (not memoized), so it always reads the latest state values from
the closure. If it gets refactored to `useCallback` later, switch to Option B.

#### 9. Update `setStep` inside `executeGeneration` for result step

Current (line 233):

```typescript
setStep(pMode === 'word_template' ? 5 : 4);
```

Change to:

```typescript
// Both WTM and magazine mode have result at step 5
setStep((pMode === 'word_template' || isMagazineTemplate) ? 5 : 4);
```

---

#### 10. Update the JSX render block — COMPLETE FINAL VERSION

This is the most critical change. Below is the **complete, final JSX** for the
step content area. It handles all three modes (normal, WTM, magazine) correctly.

Replace the entire `<div className={styles.stepContent}>...</div>` block
(currently lines 341-397) with:

```tsx
<div className={styles.stepContent}>
  {/* Step 1 — Mode Select (all modes) */}
  {step === 1 && (
    <ModeSelectScreen onSelectMode={handleModeSelect} />
  )}

  {/* Step 2 — Template Select (all modes) */}
  {step === 2 && (
    <TemplateScreen
      selectedTemplate={selectedTemplate}
      processingMode={processingMode}
      onSelect={handleTemplateSelect}
      onNext={handleTemplateNext}
      onBack={handleBack}
    />
  )}

  {/* Step 3 — Magazine: Name + Designation input */}
  {step === 3 && isMagazineTemplate && (
    <MagazineNameScreen
      onConfirm={handleMagazineNameConfirm}
      onBack={handleBack}
      initialName={magazineName}
      initialDesignation={magazineDesignation}
    />
  )}

  {/* Step 3 — WTM: Word selection */}
  {step === 3 && processingMode === 'word_template' && (
    <WordSelectionStep
      templateId={selectedTemplate}
      onConfirm={handleWordSelectionConfirm}
      onBack={handleBack}
    />
  )}

  {/* Capture step — step 3 for normal, step 4 for WTM/magazine */}
  {step === captureStep && !isEditing && (
    <CaptureScreen
      selectedTemplate={selectedTemplate}
      onCapture={handleImageCapture}
      onBack={handleBack}
      onError={handleError}
      isProcessing={isProcessing}
      processingMode={processingMode}
    />
  )}

  {/* Edit/Preview step (same step as capture, toggled by isEditing) */}
  {step === captureStep && isEditing && rawImage && templateConfig && (
    <PreviewEditScreen
      selectedTemplate={selectedTemplate}
      rawImage={rawImage}
      anchorMode={templateConfig.anchorMode}
      onComplete={handleEditComplete}
      onCancel={() => { setIsEditing(false); setRawImage(null); }}
      templateImageUrl={
        processingMode === 'word_template' && composedTemplatePath
          ? `${API_BASE_URL}/api/wtm/composed-image?path=${encodeURIComponent(composedTemplatePath)}`
          : undefined
      }
      skipConfigFetch={processingMode === 'word_template'}
    />
  )}

  {/* Result step — step 4 for normal, step 5 for WTM/magazine */}
  {step === resultStep && result && (
    <ResultScreen
      result={result}
      onStartOver={handleStartOver}
    />
  )}
</div>
```

**Why this is correct:**
- `isMagazineTemplate` and `processingMode === 'word_template'` are mutually
  exclusive — a template cannot be both magazine and WTM at the same time.
- `captureStep` resolves to 3 (normal) or 4 (WTM/magazine), covering all modes.
- `resultStep` resolves to 4 (normal) or 5 (WTM/magazine), covering all modes.
- WTM word selection at step 3 is preserved exactly as before.
- The compound conditions `(step === 4 || (step === 3 && ...))` from the original
  code are replaced by the cleaner `step === captureStep` pattern.
- `isEditing` toggle for the preview screen continues to work at `captureStep`.

---

## Full Magazine User Flow (end to end)

```
1. User taps Start → ModeSelectScreen → selects "Remove BG" (sticker mode)
2. TemplateScreen → selects a magazine template
   → selectedTemplateMode = "magazine", isMagazineTemplate = true
3. MagazineNameScreen → enters name "Jane Smith", designation "Head of Marketing"
   → handleMagazineNameConfirm → step goes to 4
4. CaptureScreen (step 4) → user takes photo
   → handleImageCapture called
   → executeGeneration("...", "sticker", undefined)
   → POST /api/generate with:
       template_id=haleon-growth-story
       photos=<blob>
       processing_mode=sticker
       magazine_name=Jane Smith
       magazine_designation=Head of Marketing
5. Backend processes: rembg → face detect → BG composite → user cutout → FG overlay → text draw
6. step → 5 → ResultScreen shows final magazine cover with name/designation
```

---

## Test Checklist (manual)

1. Select a **non-magazine, non-WTM** template → step 3 shows CaptureScreen.
   Step 4 shows ResultScreen. Everything unchanged.
2. Select a **WTM** template → step 3 shows WordSelectionStep, step 4 shows
   CaptureScreen, step 5 shows ResultScreen. Everything unchanged.
3. Select a **magazine** template → step 3 shows MagazineNameScreen.
4. On MagazineNameScreen, leave name empty → error shown, cannot proceed.
5. Fill both fields, click Next → goes to CaptureScreen (step 4).
6. Click Back on CaptureScreen → goes back to MagazineNameScreen with pre-filled values.
7. Click Back on MagazineNameScreen → goes back to TemplateScreen; name/designation cleared.
8. Complete capture on magazine template → result image contains the name and designation text.
9. Click Start Over → all state reset, back to step 1.
10. Refresh mid-flow at step 4 (magazine) → session restored: template, name, designation preserved.

---

## What This Phase Does NOT Do

- Does not build admin UI for text position config (separate task for MagazineAdmin)
- Does not handle font configuration (operational/DevOps concern)
- Does not add multi-language or RTL text support
