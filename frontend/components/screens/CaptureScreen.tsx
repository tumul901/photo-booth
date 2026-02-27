'use client';

/**
 * CaptureScreen Component (Step 3)
 * =================================
 * Photo capture/upload screen with sub-toggle for Webcam vs Upload.
 * Shows a processing overlay when the API call is in progress.
 */

import { useState } from 'react';
import WebcamCapture from '../WebcamCapture';
import ImageUpload from '../ImageUpload';
import styles from './CaptureScreen.module.css';

type CaptureMode = 'webcam' | 'upload';

interface CaptureScreenProps {
  onCapture: (imageData: string) => void;
  onBack: () => void;
  onError: (msg: string) => void;
  isProcessing: boolean;
}

export default function CaptureScreen({
  onCapture,
  onBack,
  onError,
  isProcessing,
}: CaptureScreenProps) {
  const [captureMode, setCaptureMode] = useState<CaptureMode>('webcam');

  return (
    <div className={styles.container}>
      {/* Header with back and mode toggle */}
      <div className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>
          ← Back
        </button>

        <div className={styles.modeToggle}>
          <button
            className={`${styles.toggleBtn} ${captureMode === 'webcam' ? styles.toggleBtnActive : ''}`}
            onClick={() => setCaptureMode('webcam')}
          >
            📷 Webcam
          </button>
          <button
            className={`${styles.toggleBtn} ${captureMode === 'upload' ? styles.toggleBtnActive : ''}`}
            onClick={() => setCaptureMode('upload')}
          >
            📁 Upload
          </button>
        </div>

        <div className={styles.headerSpacer} />
      </div>

      {/* Capture Area */}
      <div className={styles.captureWrapper}>
        {captureMode === 'webcam' ? (
          <WebcamCapture
            onCapture={onCapture}
            onError={onError}
            mirrored={true}
          />
        ) : (
          <ImageUpload
            onUpload={onCapture}
            onError={onError}
          />
        )}
      </div>

      {/* Processing Overlay */}
      {isProcessing && (
        <div className={styles.processingOverlay}>
          <div className={styles.spinner} />
          <p className={styles.processingText}>Processing your photo...</p>
          <p className={styles.processingHint}>This may take a moment</p>
        </div>
      )}
    </div>
  );
}
