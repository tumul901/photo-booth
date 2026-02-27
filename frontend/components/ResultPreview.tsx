'use client';

/**
 * ResultPreview Component
 * =======================
 * Displays the final composited image after processing.
 * 
 * States:
 * - Processing: Shows loading spinner
 * - Success: Displays final image
 * - Error: Shows error message with retry option
 */

import styles from './ResultPreview.module.css';

interface ResultPreviewProps {
  imageUrl: string | null;
  isLoading: boolean;
  error: string | null;
  processingMode?: 'sticker' | 'frame';
  onRetry?: () => void;
}

export default function ResultPreview({
  imageUrl,
  isLoading,
  error,
  processingMode = 'sticker',
  onRetry,
}: ResultPreviewProps) {
  if (isLoading) {
    return (
      <div className={styles.container}>
        <div className={styles.loadingState}>
          <div className={styles.spinner} />
          <p className={styles.loadingText}>Processing your photo...</p>
          <p className={styles.loadingHint}>
            {processingMode === 'frame'
              ? 'Creating your beautiful frame...'
              : 'Removing background and compositing...'}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.container}>
        <div className={styles.errorState}>
          <span className={styles.errorIcon}>⚠️</span>
          <p className={styles.errorText}>{error}</p>
          {onRetry && (
            <button onClick={onRetry} className={styles.retryButton}>
              Try Again
            </button>
          )}
        </div>
      </div>
    );
  }

  if (!imageUrl) {
    return (
      <div className={styles.container}>
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>🖼️</span>
          <p className={styles.emptyText}>Your photo will appear here</p>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.imageWrapper}>
        <img
          src={imageUrl}
          alt="Your photobooth result"
          className={styles.resultImage}
        />
      </div>
    </div>
  );
}
