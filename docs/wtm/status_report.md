# WTM Feature — Deep Status Report
Cross-referenced against `docs/wtm/` spec files and actual files on disk.

---

## ✅ IMPL-01 — Backend Core (Schemas, Config, Cache, Utils)
**Spec file:** `impl-01-backend-core.md`  
**Status: COMPLETE ✅**

| Spec Requirement | File | On Disk |
|---|---|---|
| `backend/schemas/__init__.py` | [__init__.py](file:///d:/work2/photo-booth/backend/schemas/__init__.py) | ✅ |
| `backend/schemas/wtm_schemas.py` | [wtm_schemas.py](file:///d:/work2/photo-booth/backend/schemas/wtm_schemas.py) | ✅ |
| `backend/utils/__init__.py` | [__init__.py](file:///d:/work2/photo-booth/backend/utils/__init__.py) | ✅ |
| `backend/utils/wtm_utils.py` | [wtm_utils.py](file:///d:/work2/photo-booth/backend/utils/wtm_utils.py) | ✅ |
| `backend/services/wtm_config.py` | [wtm_config.py](file:///d:/work2/photo-booth/backend/services/wtm_config.py) | ✅ |
| `backend/services/wtm_cache.py` | [wtm_cache.py](file:///d:/work2/photo-booth/backend/services/wtm_cache.py) | ✅ |
| `tests/__init__.py` | [__init__.py](file:///d:/work2/photo-booth/tests/__init__.py) | ✅ |
| `tests/wtm/__init__.py` | [__init__.py](file:///d:/work2/photo-booth/tests/wtm/__init__.py) | ✅ |
| `tests/wtm/test_config.py` | — | ⚠️ Not confirmed |
| `tests/wtm/test_cache.py` | — | ⚠️ Not confirmed |
| `backend/config.py` modified (WTM_TEMPLATES_DIR, WTM_CACHE_DIR) | — | ✅ Done in session |
| `backend/requirements.txt` modified (cairosvg, cairocffi) | — | ✅ Done in session |

> [!NOTE]
> The test files `test_config.py` and `test_cache.py` were planned. Need to verify if they exist in `tests/wtm/`.

---

## ✅ IMPL-02 — Backend API (Composer + Guest Router + Admin Router)
**Spec file:** `impl-02-backend-api.md`  
**Status: COMPLETE ✅**

| Spec Requirement | File | On Disk |
|---|---|---|
| `backend/services/wtm_composer.py` | [wtm_composer.py](file:///d:/work2/photo-booth/backend/services/wtm_composer.py) | ✅ (5.2KB) |
| `backend/api/wtm.py` | [wtm.py](file:///d:/work2/photo-booth/backend/api/wtm.py) | ✅ (2.4KB) |
| `backend/api/wtm_admin.py` | [wtm_admin.py](file:///d:/work2/photo-booth/backend/api/wtm_admin.py) | ✅ (10.5KB) |
| `tests/wtm/test_composer.py` | — | ⚠️ Not confirmed |
| `backend/main.py` modified (routers + lifespan) | — | ✅ Done in session |

**All 10 Admin endpoints covered in `wtm_admin.py`:**
- `GET /templates`, `POST /templates`, `DELETE /templates/{id}` ✅
- `GET /templates/{id}/config`, `GET /templates/{id}/image` ✅
- `PUT /templates/{id}/slots` ✅
- `POST /templates/{id}/words`, `DELETE /templates/{id}/words/{word_id}`, `GET .../svg` ✅
- `PUT /templates/{id}/bundles` ✅

---

## ✅ IMPL-03 — Admin UI (WTM Tab + Slot Editor + Word Manager + Bundle Manager)
**Spec file:** `impl-03-admin-ui.md`  
**Status: COMPLETE ✅**

| Spec Requirement | File | On Disk |
|---|---|---|
| `frontend/types/wtm.ts` | [wtm.ts](file:///d:/work2/photo-booth/frontend/types/wtm.ts) | ✅ |
| `frontend/components/WTMAdmin.tsx` | [WTMAdmin.tsx](file:///d:/work2/photo-booth/frontend/components/WTMAdmin.tsx) | ✅ (7.5KB) |
| `frontend/components/WTMAdmin.module.css` | [WTMAdmin.module.css](file:///d:/work2/photo-booth/frontend/components/WTMAdmin.module.css) | ✅ |
| `frontend/components/WTMSlotEditor.tsx` | [WTMSlotEditor.tsx](file:///d:/work2/photo-booth/frontend/components/WTMSlotEditor.tsx) | ✅ (9.9KB) |
| `frontend/components/WTMSlotEditor.module.css` | [WTMSlotEditor.module.css](file:///d:/work2/photo-booth/frontend/components/WTMSlotEditor.module.css) | ✅ |
| `frontend/components/WTMWordManager.tsx` | [WTMWordManager.tsx](file:///d:/work2/photo-booth/frontend/components/WTMWordManager.tsx) | ✅ (6.1KB) |
| `frontend/components/WTMWordManager.module.css` | [WTMWordManager.module.css](file:///d:/work2/photo-booth/frontend/components/WTMWordManager.module.css) | ✅ |
| `frontend/components/WTMBundleManager.tsx` | [WTMBundleManager.tsx](file:///d:/work2/photo-booth/frontend/components/WTMBundleManager.tsx) | ✅ (6.4KB) |
| `frontend/components/WTMBundleManager.module.css` | [WTMBundleManager.module.css](file:///d:/work2/photo-booth/frontend/components/WTMBundleManager.module.css) | ✅ |
| `frontend/app/admin/page.tsx` modified (4th tab) | — | ✅ Done in session |
| `frontend/components/index.ts` modified (barrel exports) | — | ✅ Done in session |

---

## 🔴 IMPL-04 — Guest Wizard (Word Selection + All Flow Changes)
**Spec file:** `impl-04-guest-wizard.md`  
**Status: NOT STARTED ❌**

### New Files to Create (all missing)
| File | Status |
|---|---|
| `frontend/api/wtm.ts` | ❌ Missing |
| `frontend/hooks/useWordSelection.ts` | ❌ Missing |
| `frontend/components/WordSelectionStep.tsx` + `.module.css` | ❌ Missing |
| `frontend/components/WordGrid.tsx` + `.module.css` | ❌ Missing |
| `frontend/components/WordTile.tsx` + `.module.css` | ❌ Missing |
| `frontend/components/BundleRow.tsx` + `.module.css` | ❌ Missing |
| `frontend/components/SelectionCounter.tsx` + `.module.css` | ❌ Missing |

### Existing Files to Modify (all unmodified)
| File | Required Change | Status |
|---|---|---|
| `frontend/components/screens/StartScreen.tsx` | Add `word_template` to mode type + add 3rd mode card button | ❌ Not done — still `'frame' \| 'sticker'` only |
| `frontend/components/screens/TemplateScreen.tsx` | Add `word_template` to `processingMode` type | ❌ Not done — still `'frame' \| 'sticker'` |
| `frontend/components/TemplateSelector.tsx` | Add `word_template` fetch branch + image src toggle | ❌ Not done |
| `frontend/components/StepIndicator.tsx` | Make steps dynamic (4 vs 5 steps) | ❌ Not done |
| `frontend/app/page.tsx` | 12 surgical changes (new state, WTM step block, step shifts) | ❌ Not done |
| `frontend/components/index.ts` | Add barrel exports for 5 new guest components | ❌ Not done |

---

## 📊 Overall Progress

```
IMPL-01  [██████████] 100%   Backend Core
IMPL-02  [██████████] 100%   Backend API
IMPL-03  [██████████] 100%   Admin UI
IMPL-04  [░░░░░░░░░░]   0%   Guest Wizard ← NEXT
```

---

## 🎯 What IMPL-04 Involves (Battle Plan from spec)

The spec (`impl-04-guest-wizard.md`) is fully written and extremely detailed. Key points:

1. **`frontend/api/wtm.ts`** — `fetchWords()` + `composeTemplate()` API clients
2. **`frontend/hooks/useWordSelection.ts`** — `toggle()`, `selectBundle()`, `effectiveMax` (min of maxSelections and slotCount)
3. **5 UI primitives** — `WordSelectionStep`, `WordGrid`, `WordTile`, `BundleRow`, `SelectionCounter`
4. **`page.tsx` — 12 surgical changes**, including:
   - Extend `ProcessingMode` type to include `word_template`
   - Add `selectedWords` + `composedTemplatePath` session state
   - Inject `WordSelectionStep` at step 3 (WTM only)
   - Shift `CaptureScreen` to render at step 3 OR step 4 (depending on mode)
   - Shift `ResultScreen` to render at step 4 OR step 5
   - Override `template_id` in `executeGeneration` with composed PNG path
5. **Supporting screen tweaks** — `StartScreen`, `TemplateScreen`, `TemplateSelector`, `StepIndicator`

> [!IMPORTANT]
> Before implementing step 12 of page.tsx (passing composedTemplatePath to generate), 
> check `backend/api/generate.py` to confirm the exact field name it expects for the template path.
> The spec explicitly says: **do NOT modify generate.py**, only adjust what the frontend sends.
