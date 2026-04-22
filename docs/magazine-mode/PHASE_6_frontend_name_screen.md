# Phase 6 — Frontend: MagazineNameScreen Component

## Goal
Build a self-contained `MagazineNameScreen` component that collects the user's
**Name** and **Designation** before the photo capture step. This screen only
appears when a magazine template is selected. It passes the two values upward
via a callback.

**Files created / changed:**
- `frontend/components/screens/MagazineNameScreen.tsx` — NEW component
- `frontend/components/screens/MagazineNameScreen.module.css` — NEW styles
- `frontend/components/index.ts` — add export

---

## Context — What Already Exists

| Item | Status |
|------|--------|
| `CaptureScreen`, `TemplateScreen`, etc. | ✅ exist as reference patterns |
| CSS module pattern for screens | ✅ established (e.g. `StartScreen.module.css`) |
| `isMagazineTemplate` flag in page.tsx | ✅ added in Phase 5 |
| `MagazineNameScreen` component | ❌ does not exist |

---

## New File: `frontend/components/screens/MagazineNameScreen.tsx`

```tsx
'use client';

/**
 * MagazineNameScreen
 * ==================
 * Collects the person's Name and Designation before the photo capture step.
 * Only rendered when the selected template has compositeMode === "magazine".
 *
 * Props:
 *   onConfirm(name, designation) — called when the user clicks Next
 *   onBack()                     — called when the user clicks Back
 *   initialName                  — pre-fills the name field (from sessionStorage)
 *   initialDesignation           — pre-fills the designation field
 */

import { useState, useCallback } from 'react';
import styles from './MagazineNameScreen.module.css';

interface MagazineNameScreenProps {
  onConfirm: (name: string, designation: string) => void;
  onBack: () => void;
  initialName?: string;
  initialDesignation?: string;
}

export default function MagazineNameScreen({
  onConfirm,
  onBack,
  initialName = '',
  initialDesignation = '',
}: MagazineNameScreenProps) {
  const [name, setName] = useState(initialName);
  const [designation, setDesignation] = useState(initialDesignation);
  const [errors, setErrors] = useState<{ name?: string; designation?: string }>({});

  const validate = useCallback((): boolean => {
    const newErrors: { name?: string; designation?: string } = {};
    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }
    if (!designation.trim()) {
      newErrors.designation = 'Designation is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [name, designation]);

  const handleNext = useCallback(() => {
    if (validate()) {
      onConfirm(name.trim(), designation.trim());
    }
  }, [validate, onConfirm, name, designation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleNext();
      }
    },
    [handleNext]
  );

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Your Details</h1>
        <p className={styles.subtitle}>
          These will appear on your magazine cover
        </p>

        <div className={styles.form}>
          {/* Name Field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="mag-name" className={styles.label}>
              Full Name
            </label>
            <input
              id="mag-name"
              type="text"
              className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
              placeholder="e.g. Jane Smith"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
              }}
              onKeyDown={handleKeyDown}
              autoFocus
              maxLength={60}
            />
            {errors.name && (
              <span className={styles.errorMsg}>{errors.name}</span>
            )}
          </div>

          {/* Designation Field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="mag-designation" className={styles.label}>
              Designation / Role
            </label>
            <input
              id="mag-designation"
              type="text"
              className={`${styles.input} ${errors.designation ? styles.inputError : ''}`}
              placeholder="e.g. Head of Marketing"
              value={designation}
              onChange={(e) => {
                setDesignation(e.target.value);
                if (errors.designation)
                  setErrors((prev) => ({ ...prev, designation: undefined }));
              }}
              onKeyDown={handleKeyDown}
              maxLength={80}
            />
            {errors.designation && (
              <span className={styles.errorMsg}>{errors.designation}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.backBtn} onClick={onBack} type="button">
            Back
          </button>
          <button className={styles.nextBtn} onClick={handleNext} type="button">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
```

---

## New File: `frontend/components/screens/MagazineNameScreen.module.css`

```css
/* MagazineNameScreen — full-screen centered card layout */

.container {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 100vh;
  background: #0a0a0a;
  padding: 2rem;
  box-sizing: border-box;
}

.card {
  background: #1a1a1a;
  border: 1px solid #2a2a2a;
  border-radius: 16px;
  padding: 3rem 2.5rem;
  width: 100%;
  max-width: 480px;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.title {
  font-size: 2rem;
  font-weight: 700;
  color: #ffffff;
  margin: 0;
  text-align: center;
  letter-spacing: -0.02em;
}

.subtitle {
  font-size: 0.95rem;
  color: #888;
  text-align: center;
  margin: 0;
}

.form {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.fieldGroup {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}

.label {
  font-size: 0.85rem;
  font-weight: 600;
  color: #aaa;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.input {
  background: #0d0d0d;
  border: 1.5px solid #333;
  border-radius: 10px;
  color: #ffffff;
  font-size: 1.1rem;
  padding: 0.8rem 1rem;
  outline: none;
  transition: border-color 0.15s;
  width: 100%;
  box-sizing: border-box;
}

.input::placeholder {
  color: #444;
}

.input:focus {
  border-color: #555;
}

.inputError {
  border-color: #e05252;
}

.errorMsg {
  font-size: 0.8rem;
  color: #e05252;
}

.actions {
  display: flex;
  gap: 1rem;
  margin-top: 0.5rem;
}

.backBtn {
  flex: 1;
  padding: 0.85rem;
  border-radius: 10px;
  border: 1.5px solid #333;
  background: transparent;
  color: #aaa;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s;
}

.backBtn:hover {
  border-color: #555;
  color: #fff;
}

.nextBtn {
  flex: 2;
  padding: 0.85rem;
  border-radius: 10px;
  border: none;
  background: #ffffff;
  color: #000000;
  font-size: 1rem;
  font-weight: 700;
  cursor: pointer;
  transition: background 0.15s;
}

.nextBtn:hover {
  background: #e0e0e0;
}
```

---

## Update: `frontend/components/index.ts`

Add the new export alongside the existing ones:

```typescript
export { default as MagazineNameScreen } from './screens/MagazineNameScreen';
```

---

## Component Contract Summary

| Prop | Type | Required | Description |
|------|------|----------|-------------|
| `onConfirm` | `(name: string, designation: string) => void` | Yes | Called with trimmed values when Next is clicked and validation passes |
| `onBack` | `() => void` | Yes | Called when Back is clicked |
| `initialName` | `string` | No | Pre-fills the name input (from sessionStorage) |
| `initialDesignation` | `string` | No | Pre-fills the designation input |

### Validation Rules
- Both fields must be non-empty after trimming
- Inline error messages appear below the failing field
- Errors clear immediately when the user starts typing in the field

### UX Details
- `autoFocus` on the name field so user can start typing immediately
- `Enter` key on either field triggers the same validation + submit as the Next button
- `maxLength` 60 for name, 80 for designation to prevent runaway text

---

## Test Checklist (manual)

1. Render `<MagazineNameScreen onConfirm={...} onBack={...} />` in isolation
   (can temporarily wire it into the page.tsx render for testing).
2. Click Next with both fields empty → both error messages appear.
3. Fill name, leave designation empty → only designation error.
4. Fill both, click Next → `onConfirm("Jane Smith", "Head of Marketing")` called.
5. Fill both, press Enter → same as clicking Next.
6. Click Back → `onBack()` called.
7. Pass `initialName="Alice"` → input pre-filled with "Alice".

---

## What This Phase Does NOT Do

- Does not insert this screen into the wizard flow (Phase 7)
- Does not send name/designation to the API (Phase 7)
- Does not modify any backend code
