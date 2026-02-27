'use client';

/**
 * ResultScreen Component (Step 4)
 * ================================
 * Final screen showing the processed image, QR code, download options.
 * Auto-resets after 60 seconds for next guest.
 */

import { useState, useEffect } from 'react';
import DownloadPanel from '../DownloadPanel';
import styles from './ResultScreen.module.css';

interface ResultScreenProps {
  result: {
    outputId: string;
    downloadUrl: string;
    shareUrl: string;
  };
  onStartOver: () => void;
}

export default function ResultScreen({ result, onStartOver }: ResultScreenProps) {
  const [timeLeft, setTimeLeft] = useState(60);

  useEffect(() => {
    if (timeLeft <= 0) {
      onStartOver();
    }
  }, [timeLeft, onStartOver]);

  useEffect(() => {
    const timer = setInterval(() => {
      setTimeLeft((prev) => prev - 1);
    }, 1000);
    return () => clearInterval(timer);
  }, []);

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
            />
          </div>

          <div className={styles.footer}>
            <button className={styles.startOverButton} onClick={onStartOver}>
              ↻ Start Over ({timeLeft}s)
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
