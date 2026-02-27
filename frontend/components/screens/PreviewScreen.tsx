'use client';

/**
 * PreviewScreen Component
 * =======================
 * Shows the processed result with retake/confirm options.
 * Displays processing state, error state, or final preview.
 */

import ResultPreview from '../ResultPreview';
import styles from './PreviewScreen.module.css';

interface PreviewScreenProps {
  result: { downloadUrl: string } | null;
  isProcessing: boolean;
  error: string | null;
  onRetake: () => void;
  onConfirm: () => void;
}

export default function PreviewScreen({ result, isProcessing, error, onRetake, onConfirm }: PreviewScreenProps) {
  return (
    <div className={styles.container}>
      <h2 className={styles.title}>
        {isProcessing ? 'Creating Magic...' : error ? 'Oops!' : "Lookin' Good?"}
      </h2>

      <div className={styles.previewArea}>
        <ResultPreview
          imageUrl={result?.downloadUrl}
          isLoading={isProcessing}
          error={error}
          processingMode="frame"
          onRetry={onRetake}
        />
      </div>

      {!isProcessing && !error && (
        <footer className={styles.footer}>
          <button className={styles.retakeButton} onClick={onRetake}>↺ Retake</button>
          <button className={styles.confirmButton} onClick={onConfirm}>Yes, Print it! →</button>
        </footer>
      )}

      {error && (
        <footer className={styles.footer}>
          <button className={styles.retakeButton} onClick={onRetake}>Try Again</button>
        </footer>
      )}
    </div>
  );
}
