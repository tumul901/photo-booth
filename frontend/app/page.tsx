'use client';

/**
 * Photobooth Main Page — Step-Wise Wizard
 * ========================================
 * 4-step fullscreen wizard with refresh-proof sessionStorage persistence:
 *   Step 1: Mode Selection (Frame / Remove BG)
 *   Step 2: Template Selection
 *   Step 3: Photo Capture / Upload
 *   Step 4: Result (image + QR + print/share/download)
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import { type ProcessingMode, isArtworkMode } from '@/types/processingMode';
import StepIndicator from '../components/StepIndicator';
import ModeSelectScreen from '../components/screens/StartScreen';
import TemplateScreen from '../components/screens/TemplateScreen';
import CaptureScreen from '../components/screens/CaptureScreen';
import PreviewEditScreen from '../components/screens/PreviewEditScreen';
import ResultScreen from '../components/screens/ResultScreen';
import WordSelectionStep from '../components/WordSelectionStep';
import MagazineNameScreen from '../components/screens/MagazineNameScreen';
import CaptureFormScreen from '../components/screens/CaptureFormScreen';
import styles from './page.module.css';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

// ─── Session Storage Helpers ──────────────────────────────────────────

const STORAGE_PREFIX = 'photobooth_';

function saveToSession<T>(key: string, value: T): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(value));
  } catch {
    // Silently fail if storage is full or unavailable
  }
}

function loadFromSession<T>(key: string, fallback: T): T {
  if (typeof window === 'undefined') return fallback;
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clearSession(): void {
  if (typeof window === 'undefined') return;
  const keys = Object.keys(sessionStorage);
  keys.forEach((k) => {
    if (k.startsWith(STORAGE_PREFIX)) {
      sessionStorage.removeItem(k);
    }
  });
}

// ─── Custom Hook: useState synced with sessionStorage ──────────────────

function useSessionState<T>(key: string, defaultValue: T): [T, (val: T | ((prev: T) => T)) => void] {
  const [state, setStateRaw] = useState<T>(defaultValue);
  const initialized = useRef(false);

  // Restore from session on mount (client only)
  useEffect(() => {
    const stored = loadFromSession<T>(key, defaultValue);
    setStateRaw(stored);
    initialized.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist to session on every change (after init)
  const setState = useCallback((val: T | ((prev: T) => T)) => {
    setStateRaw((prev) => {
      const next = typeof val === 'function' ? (val as (prev: T) => T)(prev) : val;
      saveToSession(key, next);
      return next;
    });
  }, [key]);

  return [state, setState];
}

// ─── Result Type ──────────────────────────────────────────────────────

interface ResultData {
  outputId: string;
  downloadUrl: string;
  shareUrl: string;
  printWidthMm?: number;
  printHeightMm?: number;
  /** Real encoding the backend saved — the download filename must match it. */
  outputFormat?: string;
  /** True when the artwork carries alpha (transparent inside the triangle). */
  transparent?: boolean;
}

// ProcessingMode now lives in types/processingMode.ts — see the note there.

// ─── Main Component ──────────────────────────────────────────────────

export default function BoothPage() {
  // All wizard state uses sessionStorage-backed hooks
  const [step, setStep] = useSessionState<number>('step', 1);
  const [processingMode, setProcessingMode] = useSessionState<ProcessingMode>('processingMode', 'frame');
  const [selectedTemplate, setSelectedTemplate] = useSessionState<string>('selectedTemplate', '');
  const [result, setResult] = useSessionState<ResultData | null>('result', null);
  const [selectedWords, setSelectedWords] = useSessionState<string[]>('selectedWords', []);
  const [composedTemplatePath, setComposedTemplatePath] = useSessionState<string | null>('composedTemplatePath', null);
  const [selectedTemplateMode, setSelectedTemplateMode] = useSessionState<string>('selectedTemplateMode', '');
  const [magazineName, setMagazineName] = useSessionState<string>('magazineName', '');
  const [magazineDesignation, setMagazineDesignation] = useSessionState<string>('magazineDesignation', '');
  const [overlayName, setOverlayName] = useSessionState<string>('overlayName', '');
  const [overlayDesignation, setOverlayDesignation] = useSessionState<string>('overlayDesignation', '');
  const [wtmName, setWtmName] = useSessionState<string>('wtmName', '');
  const [wtmDesignation, setWtmDesignation] = useSessionState<string>('wtmDesignation', '');
  // Capture form — persisted so a refresh mid-session doesn't re-ask
  const [guestName, setGuestName] = useSessionState<string>('guestName', '');
  const [guestPhone, setGuestPhone] = useSessionState<string>('guestPhone', '');

  // Transient state (not persisted — doesn't survive refresh by design)
  const [captureFormEnabled, setCaptureFormEnabled] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [templateConfig, setTemplateConfig] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Overlay flags: set by fetching template config when a template is selected
  const [templateHasNameText, setTemplateHasNameText] = useState(false);
  const [templateHasDesignationText, setTemplateHasDesignationText] = useState(false);
  const [templatePrintWidthMm, setTemplatePrintWidthMm] = useState<number | undefined>(undefined);
  const [templatePrintHeightMm, setTemplatePrintHeightMm] = useState<number | undefined>(undefined);

  // True when the selected template uses magazine composite mode
  const isMagazineTemplate = selectedTemplateMode === 'magazine';
  // True when a sticker/luggage card template has name or designation overlay configured
  const isOverlayTemplate = !isMagazineTemplate && (templateHasNameText || templateHasDesignationText);

  // Fetch capture_form flag on mount so the booth knows whether to show the form.
  useEffect(() => {
    fetch(`${API_BASE_URL}/api/feature-flags`)
      .then(r => r.ok ? r.json() : null)
      .then(flags => { if (flags) setCaptureFormEnabled(!!flags.capture_form); })
      .catch(() => {});
  }, []);

  // Fetch template config when a template is selected to detect overlay flags.
  // WTM templates live in the WTM config system, not /api/admin/templates — skip them.
  useEffect(() => {
    if (!selectedTemplate || processingMode === 'word_template') {
      setTemplateHasNameText(false);
      setTemplateHasDesignationText(false);
      return;
    }
    fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`)
      .then(r => r.ok ? r.json() : null)
      .then(cfg => {
        if (!cfg) return;
        setTemplateHasNameText(!!(cfg.name_text && Object.keys(cfg.name_text).length > 0));
        setTemplateHasDesignationText(!!(cfg.designation_text && Object.keys(cfg.designation_text).length > 0));
        if (cfg.luggage_card_mode) {
          setTemplatePrintWidthMm(cfg.print_width_mm ?? 86);
          setTemplatePrintHeightMm(cfg.print_height_mm ?? 54);
        } else {
          setTemplatePrintWidthMm(undefined);
          setTemplatePrintHeightMm(undefined);
        }
      })
      .catch(() => {});
  }, [selectedTemplate, processingMode]);

  // WTM, magazine, and overlay templates insert an extra step at position 3
  const hasExtraStep = processingMode === 'word_template' || processingMode === 'magazine' || isMagazineTemplate || isOverlayTemplate;
  const captureStep = hasExtraStep ? 4 : 3;
  const resultStep  = hasExtraStep ? 5 : 4;

  // ─── Handlers ────────────────────────────────────────────────────

  const handleModeSelect = useCallback((mode: ProcessingMode) => {
    setProcessingMode(mode);
    setStep(2);
  }, [setProcessingMode, setStep]);

  const handleTemplateSelect = useCallback((id: string, compositeMode: string) => {
    setSelectedTemplate(id);
    setSelectedTemplateMode(compositeMode);
  }, [setSelectedTemplate, setSelectedTemplateMode]);

  const handleTemplateNext = useCallback(() => {
    if (selectedTemplate) setStep(3);
  }, [selectedTemplate, setStep]);

  const handleMagazineNameConfirm = useCallback(
    (name: string, designation: string) => {
      setMagazineName(name);
      setMagazineDesignation(designation);
      setStep(captureStep);
    },
    [setMagazineName, setMagazineDesignation, setStep, captureStep]
  );

  const handleOverlayNameConfirm = useCallback(
    (name: string, designation: string) => {
      setOverlayName(name);
      setOverlayDesignation(designation);
      setStep(captureStep);
    },
    [setOverlayName, setOverlayDesignation, setStep, captureStep]
  );

  const handleBack = useCallback(() => {
    // WTM: clear word selections and name/designation when stepping back from word selection screen
    if (step === 3 && processingMode === 'word_template') {
      setSelectedWords([]);
      setComposedTemplatePath(null);
      setWtmName('');
      setWtmDesignation('');
    }
    // Magazine: clear name/designation when stepping back FROM name screen TO templates
    if (step === 3 && isMagazineTemplate) {
      setMagazineName('');
      setMagazineDesignation('');
    }
    // Overlay: clear name/designation when stepping back FROM name screen TO templates
    if (step === 3 && isOverlayTemplate) {
      setOverlayName('');
      setOverlayDesignation('');
    }
    // Note: stepping back from capture (step 4) to name screen (step 3)
    // does NOT clear values — they stay pre-filled so user doesn't re-type.
    setStep((prev: number) => Math.max(1, prev - 1));
    setError(null);
  }, [
    step, processingMode, isMagazineTemplate, isOverlayTemplate,
    setStep, setSelectedWords, setComposedTemplatePath,
    setMagazineName, setMagazineDesignation, setWtmName, setWtmDesignation,
    setOverlayName, setOverlayDesignation,
  ]);

  const compressImage = async (dataUrl: string, maxWidth = 1920, maxHeight = 1920, quality = 0.85): Promise<Blob> => {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxWidth || height > maxHeight) {
          if (width > height) {
            height = Math.round((height * maxWidth) / width);
            width = maxWidth;
          } else {
            width = Math.round((width * maxHeight) / height);
            height = maxHeight;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) return reject(new Error('Canvas context failed'));
        // Fill white background in case of transparent PNG
        ctx.fillStyle = '#FFFFFF';
        ctx.fillRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          if (blob) resolve(blob);
          else reject(new Error('Compression failed'));
        }, 'image/jpeg', quality);
      };
      img.onerror = () => reject(new Error('Image load failed'));
      img.src = dataUrl;
    });
  };

  const executeGeneration = useCallback(async (imageData: string, pMode: string, positionData?: any) => {
    setIsProcessing(true);
    setResult(null);
    setError(null);

    try {
      let blob: Blob;

      const isPreExtracted = pMode === 'pre_extracted' || (pMode === 'word_template' && !!positionData);
      if (isPreExtracted) {
        // Skip canvas compression to preserve exact PNG transparency from the extraction API
        const res = await fetch(imageData);
        blob = await res.blob();
      } else {
        // Compress natural webcam captures as JPEG
        blob = await compressImage(imageData);
      }

      // WTM mode: send composed template path and use dedicated endpoint
      const isWTM = pMode === 'word_template' && composedTemplatePath;

      // Determine backend processing mode once — avoids duplicate FormData key
      // WTM + positionData means the image was already extracted by PreviewEditScreen
      const backendMode = (isWTM && positionData) ? 'pre_extracted' : pMode;

      // Build FormData
      const formData = new FormData();
      formData.append('template_id', selectedTemplate);
      formData.append('photos', blob, backendMode === 'pre_extracted' ? 'photo.png' : 'photo.jpg');
      formData.append('processing_mode', backendMode);

      if (positionData) {
        formData.append('photo_position', JSON.stringify(positionData));
      }

      if (isWTM) {
        formData.append('composed_template_path', composedTemplatePath!);
        if (wtmName) formData.append('wtm_name', wtmName);
        if (wtmDesignation) formData.append('wtm_designation', wtmDesignation);
      }

      // Magazine mode: send name and designation
      if (isMagazineTemplate && magazineName) {
        formData.append('magazine_name', magazineName);
        formData.append('magazine_designation', magazineDesignation);
      }

      // Sticker/luggage card overlay mode: send overlay name and designation
      if (isOverlayTemplate && overlayName) {
        formData.append('overlay_name', overlayName);
        formData.append('overlay_designation', overlayDesignation);
      }

      // Capture form: always send guest identity if collected (empty string is fine)
      formData.append('guest_name', guestName);
      formData.append('guest_phone', guestPhone);

      // Send to backend
      console.time('API Generate Request');
      const endpoint = isWTM ? `${API_BASE_URL}/api/wtm/generate` : `${API_BASE_URL}/api/generate`;
      const apiRes = await fetch(endpoint, {
        method: 'POST',
        body: formData,
      });

      if (!apiRes.ok) {
        console.timeEnd('API Generate Request');
        const errData = await apiRes.json().catch(() => ({}));
        throw new Error(errData.error || `Server error: ${apiRes.status}`);
      }

      const data = await apiRes.json();
      console.timeEnd('API Generate Request');
      if (!data.success) throw new Error(data.error || 'Processing failed');

      const resultData: ResultData = {
        outputId: data.output_id,
        downloadUrl: data.download_url,
        shareUrl: data.output_url,
        printWidthMm: templatePrintWidthMm,
        printHeightMm: templatePrintHeightMm,
        outputFormat: data.output_format,
        transparent: data.transparent,
      };

      setResult(resultData);
      setStep((pMode === 'word_template' || isMagazineTemplate || isOverlayTemplate) ? 5 : 4);
    } catch (err) {
      console.error('Generate failed:', err);
      setError(err instanceof Error ? err.message : 'Processing failed. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  }, [selectedTemplate, composedTemplatePath, wtmName, wtmDesignation, isMagazineTemplate, magazineName, magazineDesignation, isOverlayTemplate, overlayName, overlayDesignation, templatePrintWidthMm, templatePrintHeightMm, setStep, setIsProcessing, setResult, setError]);

  const handleImageCapture = useCallback(async (imageData: string) => {
    setError(null);

    if (!selectedTemplate) {
      setError('Please select a template first.');
      return;
    }

    // WTM mode: never falls through to the regular /api/admin/templates config fetch below
    if (processingMode === 'word_template') {
      if (!composedTemplatePath) {
        // Word selection was not completed — send user back to that step
        setStep(3);
        return;
      }

      let allowManual = true;
      let wtmCfg: any = null;
      try {
        const res = await fetch(`${API_BASE_URL}/api/admin/wtm/templates/${selectedTemplate}/config`);
        if (res.ok) {
          wtmCfg = await res.json();
          // If field is explicitly false, skip edit screen; missing = default true
          allowManual = wtmCfg.allow_manual_positioning !== false;
        }
      } catch { /* network error — fall back to showing edit screen */ }

      // Always store rawImage + templateConfig so "Adjust Placement" works from result screen
      const wtmConfig = {
        templateType: 'sticker',
        isWTM: true,
        anchorMode: 'bbox_center',
        photoSlot: wtmCfg?.photo_slot ?? null,
      };
      setRawImage(imageData);
      setTemplateConfig(wtmConfig);

      if (allowManual) {
        setIsEditing(true);
        return;
      }

      // allow_manual_positioning=false — auto-generate; button still available from result
      executeGeneration(imageData, processingMode);
      return;
    }

    // Store raw image so user can re-open placement editor from the result screen
    setRawImage(imageData);

    // Fetch config for the placement editor; default to {} so the button always appears
    let config: any = {};
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`);
      config = res.ok ? await res.json() : {};
    } catch {
      config = {};
    }

    // Map the template's first slot into photoSlot so the editor can auto-fit the
    // cutout, draw the slot outline, and offer "Reset Position" (mirrors WTM).
    const slot = Array.isArray(config.slots) ? config.slots[0] : null;
    config.photoSlot = slot
      ? { x: slot.x, y: slot.y, width: slot.width, height: slot.height }
      : null;
    setTemplateConfig(config);

    // If Interactive Repositioning is enabled, show the placement editor first
    // (capture → BG removal → adjust → result). The editor handles extraction.
    // Magazine uses a different FG-overlay composite and is excluded (same as the
    // post-result adjust button below).
    // Artwork modes are excluded by design: the guest already framed themselves
    // against the live triangle guide, so a placement editor would only let them
    // undo that. Magazine uses a different FG-overlay composite.
    if (
      config.allowManualPositioning &&
      !isMagazineTemplate &&
      processingMode !== 'magazine' &&
      !isArtworkMode(processingMode)
    ) {
      setIsEditing(true);
      return;
    }

    // Otherwise auto-generate straight to the result, where the
    // "Adjust Sticker Placement" button remains available as a fallback.
    executeGeneration(imageData, processingMode);
  }, [selectedTemplate, processingMode, composedTemplatePath, executeGeneration, isMagazineTemplate]);

  const handleEditComplete = useCallback((extractedBase64: string, position: any) => {
    setIsEditing(false);
    if (processingMode === 'word_template' && composedTemplatePath) {
      executeGeneration(extractedBase64, "word_template", position);
    } else {
      executeGeneration(extractedBase64, "pre_extracted", position);
    }
  }, [processingMode, composedTemplatePath, executeGeneration]);

  const handleWordSelectionConfirm = useCallback((composedPath: string, name: string, designation: string) => {
    setComposedTemplatePath(composedPath);
    setWtmName(name);
    setWtmDesignation(designation);
    setStep(4);
  }, [setComposedTemplatePath, setWtmName, setWtmDesignation, setStep]);

  const handleCaptureFormConfirm = useCallback((name: string, phone: string) => {
    setGuestName(name);
    setGuestPhone(phone);
    setStep(1);
  }, [setGuestName, setGuestPhone, setStep]);

  const handleStartOver = useCallback(() => {
    // Keep processingMode so the user lands back on template selection in the same mode
    const currentMode = processingMode;
    clearSession();
    setProcessingMode(currentMode);
    // If capture form is on, return to it so new guest info is collected each session
    setStep(captureFormEnabled ? 0 : 2);
    // Clear the in-flight capture/editor state so the next guest never inherits
    // the previous guest's photo, cutout, or open editor.
    setIsEditing(false);
    setRawImage(null);
    setTemplateConfig(null);
    setSelectedTemplate('');
    setSelectedTemplateMode('');
    setResult(null);
    setSelectedWords([]);
    setComposedTemplatePath(null);
    setMagazineName('');
    setMagazineDesignation('');
    setOverlayName('');
    setOverlayDesignation('');
    setWtmName('');
    setWtmDesignation('');
    setGuestName('');
    setGuestPhone('');
    setError(null);
    setIsProcessing(false);
  }, [processingMode, captureFormEnabled, setStep, setProcessingMode, setSelectedTemplate, setSelectedTemplateMode, setResult, setSelectedWords, setComposedTemplatePath, setMagazineName, setMagazineDesignation, setOverlayName, setOverlayDesignation, setWtmName, setWtmDesignation, setGuestName, setGuestPhone]);

  const handleError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <main className={styles.main}>
      {/* Step Indicator (hidden on step 1 for cleaner attract screen) */}
      {step > 1 && (
        <div className={styles.stepBar}>
          <StepIndicator currentStep={step} processingMode={processingMode} />
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className={styles.error}>⚠️ {error}</div>
      )}

      {/* Step Content */}
      <div className={styles.stepContent}>
        {/* Step 0 — Capture form (name + phone), only when flag is ON */}
        {step === 0 && captureFormEnabled && (
          <CaptureFormScreen onConfirm={handleCaptureFormConfirm} />
        )}

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
            mode="magazine"
            onConfirm={handleMagazineNameConfirm}
            onBack={handleBack}
            initialName={magazineName}
            initialDesignation={magazineDesignation}
          />
        )}

        {/* Step 3 — Sticker/Luggage card: overlay name + designation input */}
        {step === 3 && isOverlayTemplate && (
          <MagazineNameScreen
            mode="overlay"
            showName={templateHasNameText}
            showDesignation={templateHasDesignationText}
            onConfirm={handleOverlayNameConfirm}
            onBack={handleBack}
            initialName={overlayName}
            initialDesignation={overlayDesignation}
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

        {/* Edit/Preview — shown at captureStep for WTM first-edit, or at resultStep for post-result adjustment */}
        {(step === captureStep || step === resultStep) && isEditing && rawImage && templateConfig && (
          <PreviewEditScreen
            selectedTemplate={selectedTemplate}
            rawImage={rawImage}
            anchorMode={templateConfig.anchorMode}
            onComplete={handleEditComplete}
            onCancel={
              step === resultStep
                ? () => setIsEditing(false)
                : () => { setIsEditing(false); setRawImage(null); }
            }
            templateImageUrl={
              processingMode === 'word_template' && composedTemplatePath
                ? `${API_BASE_URL}/api/wtm/composed-image?path=${encodeURIComponent(composedTemplatePath)}`
                : undefined
            }
            skipConfigFetch={processingMode === 'word_template'}
            photoSlot={templateConfig?.photoSlot}
            // Reuse the cached cutout only when adjusting an existing result; at
            // captureStep the editor extracts a fresh capture and any lingering
            // result.outputId would belong to a previous photo.
            cutoutOutputId={step === resultStep ? result?.outputId : undefined}
          />
        )}

        {/* Result step — step 4 for normal, step 5 for WTM/magazine */}
        {step === resultStep && result && !isEditing && (
          <ResultScreen
            result={result}
            onStartOver={handleStartOver}
            onAdjustPlacement={
              rawImage && templateConfig
                && processingMode !== 'magazine' && !isArtworkMode(processingMode)
                ? () => setIsEditing(true)
                : undefined
            }
          />
        )}
      </div>
    </main>
  );
}
