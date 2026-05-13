'use client';

/**
 * ResultScreen Component (Step 4)
 * ================================
 * Final screen showing the processed image, QR code, download options.
 */

import DownloadPanel from '../DownloadPanel';
import styles from './ResultScreen.module.css';

interface ResultScreenProps {
  result: {
    outputId: string;
    downloadUrl: string;
    shareUrl: string;
    printWidthMm?: number;
    printHeightMm?: number;
  };
  onStartOver: () => void;
  onAdjustPlacement?: () => void;
}

export default function ResultScreen({ result, onStartOver, onAdjustPlacement }: ResultScreenProps) {
  return (
    <div className={styles.container}>
      <div className={styles.splitLayout}>
        {/* Image Side */}
        <div className={styles.imageSide}>
          <img src={result.downloadUrl} alt="Final Result" className={styles.finalImage} />
        </div>

        {/* Action Side */}
        <div className={styles.actionSide}>
          <h2 className={styles.title}>Your Photo is Ready! 🎉</h2>
          <p className={styles.subtitle}>Scan, download, or share your photo</p>

          <div className={styles.panelWrapper}>
            <DownloadPanel
              downloadUrl={result.downloadUrl}
              shareUrl={result.shareUrl}
              outputId={result.outputId}
              isReady={true}
              printWidthMm={result.printWidthMm}
              printHeightMm={result.printHeightMm}
            />
          </div>

          <div className={styles.footer}>
            {onAdjustPlacement && (
              <button className={styles.adjustButton} onClick={onAdjustPlacement}>
                ✦ Adjust Sticker Placement
              </button>
            )}
            <button className={styles.startOverButton} onClick={onStartOver}>
              ↻ Start Over
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

