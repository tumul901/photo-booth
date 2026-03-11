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
import StepIndicator from '../components/StepIndicator';
import ModeSelectScreen from '../components/screens/StartScreen';
import TemplateScreen from '../components/screens/TemplateScreen';
import CaptureScreen from '../components/screens/CaptureScreen';
import PreviewEditScreen from '../components/screens/PreviewEditScreen';
import ResultScreen from '../components/screens/ResultScreen';
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
}

type ProcessingMode = 'frame' | 'sticker';

// ─── Main Component ──────────────────────────────────────────────────

export default function BoothPage() {
  // All wizard state uses sessionStorage-backed hooks
  const [step, setStep] = useSessionState<number>('step', 1);
  const [processingMode, setProcessingMode] = useSessionState<ProcessingMode>('processingMode', 'frame');
  const [selectedTemplate, setSelectedTemplate] = useSessionState<string>('selectedTemplate', '');
  const [result, setResult] = useSessionState<ResultData | null>('result', null);

  // Transient state (not persisted — doesn't survive refresh by design)
  const [isEditing, setIsEditing] = useState(false);
  const [rawImage, setRawImage] = useState<string | null>(null);
  const [templateConfig, setTemplateConfig] = useState<any>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // ─── Handlers ────────────────────────────────────────────────────

  const handleModeSelect = useCallback((mode: ProcessingMode) => {
    setProcessingMode(mode);
    setStep(2);
  }, [setProcessingMode, setStep]);

  const handleTemplateSelect = useCallback((id: string) => {
    setSelectedTemplate(id);
  }, [setSelectedTemplate]);

  const handleTemplateNext = useCallback(() => {
    if (selectedTemplate) setStep(3);
  }, [selectedTemplate, setStep]);

  const handleBack = useCallback(() => {
    setStep((prev: number) => Math.max(1, prev - 1));
    setError(null);
  }, [setStep]);

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

  const executeGeneration = async (imageData: string, pMode: string, positionData?: any) => {
    setIsProcessing(true);
    setResult(null);
    setError(null);

    try {
      let blob: Blob;
      
      if (pMode === 'pre_extracted') {
        // Skip canvas compression to preserve exact PNG transparency from the extraction API
        const res = await fetch(imageData);
        blob = await res.blob();
      } else {
        // Compress natural webcam captures as JPEG
        blob = await compressImage(imageData);
      }

      // Build FormData
      const formData = new FormData();
      formData.append('template_id', selectedTemplate);
      formData.append('photos', blob, pMode === 'pre_extracted' ? 'photo.png' : 'photo.jpg');
      formData.append('processing_mode', pMode);
      
      if (positionData) {
        formData.append('photo_position', JSON.stringify(positionData));
      }

      // Send to backend
      console.time('API Generate Request');
      const apiRes = await fetch(`${API_BASE_URL}/api/generate`, {
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
      };

      setResult(resultData);
      setStep(4);
    } catch (err) {
      console.error('Generate failed:', err);
      setError(err instanceof Error ? err.message : 'Processing failed. Please try again.');
    } finally {
      setIsProcessing(false);
    }
  };

  const handleImageCapture = useCallback(async (imageData: string) => {
    setError(null);

    if (!selectedTemplate) {
      setError('Please select a template first.');
      return;
    }

    // Check if template permits interactive manual positioning
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/templates/${selectedTemplate}/config`);
      if (res.ok) {
        const config = await res.json();
        if (config.allowManualPositioning) {
          setRawImage(imageData);
          setTemplateConfig(config);
          setIsEditing(true);
          return;
        }
      }
    } catch (e) {
      console.error("Config fetch failed, proceeding to direct generate");
    }

    // Standard auto-compose flow
    executeGeneration(imageData, processingMode);
  }, [selectedTemplate, processingMode]);

  const handleEditComplete = useCallback((extractedBase64: string, position: any) => {
    setIsEditing(false);
    // Submit the already-transparent image using the special pre_extracted mode
    executeGeneration(extractedBase64, "pre_extracted", position);
  }, [selectedTemplate, processingMode]);

  const handleStartOver = useCallback(() => {
    clearSession();
    setStep(1);
    setProcessingMode('frame');
    setSelectedTemplate('');
    setResult(null);
    setError(null);
    setIsProcessing(false);
  }, [setStep, setProcessingMode, setSelectedTemplate, setResult]);

  const handleError = useCallback((msg: string) => {
    setError(msg);
  }, []);

  // ─── Render ──────────────────────────────────────────────────────

  return (
    <main className={styles.main}>
      {/* Step Indicator (hidden on step 1 for cleaner attract screen) */}
      {step > 1 && (
        <div className={styles.stepBar}>
          <StepIndicator currentStep={step} />
        </div>
      )}

      {/* Error Banner */}
      {error && (
        <div className={styles.error}>⚠️ {error}</div>
      )}

      {/* Step Content */}
      <div className={styles.stepContent}>
        {step === 1 && (
          <ModeSelectScreen onSelectMode={handleModeSelect} />
        )}

        {step === 2 && (
          <TemplateScreen
            selectedTemplate={selectedTemplate}
            processingMode={processingMode}
            onSelect={handleTemplateSelect}
            onNext={handleTemplateNext}
            onBack={handleBack}
          />
        )}

        {step === 3 && !isEditing && (
          <CaptureScreen
            selectedTemplate={selectedTemplate}
            onCapture={handleImageCapture}
            onBack={handleBack}
            onError={handleError}
            isProcessing={isProcessing}
          />
        )}

        {step === 3 && isEditing && rawImage && templateConfig && (
          <PreviewEditScreen
            selectedTemplate={selectedTemplate}
            rawImage={rawImage}
            anchorMode={templateConfig.anchorMode}
            onComplete={handleEditComplete}
            onCancel={() => { setIsEditing(false); setRawImage(null); }}
          />
        )}

        {step === 4 && result && (
          <ResultScreen
            result={result}
            onStartOver={handleStartOver}
          />
        )}
      </div>
    </main>
  );
}
