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

  const handleImageCapture = useCallback(async (imageData: string) => {
    setError(null);

    if (!selectedTemplate) {
      setError('Please select a template first.');
      return;
    }

    setIsProcessing(true);
    setResult(null);

    try {
      // Convert base64 data URL to Blob
      const response = await fetch(imageData);
      const blob = await response.blob();

      // Build FormData
      const formData = new FormData();
      formData.append('template_id', selectedTemplate);
      formData.append('photos', blob, 'photo.png');
      formData.append('processing_mode', processingMode);

      // Send to backend
      const apiRes = await fetch(`${API_BASE_URL}/api/generate`, {
        method: 'POST',
        body: formData,
      });

      if (!apiRes.ok) {
        const errData = await apiRes.json().catch(() => ({}));
        throw new Error(errData.error || `Server error: ${apiRes.status}`);
      }

      const data = await apiRes.json();
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
  }, [selectedTemplate, processingMode, setResult, setStep]);

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

        {step === 3 && (
          <CaptureScreen
            onCapture={handleImageCapture}
            onBack={handleBack}
            onError={handleError}
            isProcessing={isProcessing}
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
