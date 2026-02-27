'use client';

/**
 * DownloadPanel Component
 * =======================
 * Provides download button, QR code for sharing, and print option.
 * Designed for mobile/tablet-first event photobooth use.
 */

import { useState, useCallback, useEffect } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import styles from './DownloadPanel.module.css';

interface DownloadPanelProps {
  downloadUrl: string | null;
  shareUrl: string | null;
  outputId: string | null;
  isReady: boolean;
}

export default function DownloadPanel({
  downloadUrl,
  shareUrl,
  outputId,
  isReady,
}: DownloadPanelProps) {
  const [canShare, setCanShare] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  // Check for native share support
  useEffect(() => {
    if (typeof navigator !== 'undefined' && 'share' in navigator) {
      setCanShare(true);
    }
  }, []);

  const showToast = useCallback((message: string) => {
    setToastMessage(message);
    setTimeout(() => setToastMessage(null), 3000);
  }, []);

  const handleDownload = useCallback(() => {
    if (!downloadUrl) return;

    try {
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `photobooth-${outputId || 'photo'}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast('Download started! 📥');
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, [downloadUrl, outputId, showToast]);

  const handleShare = useCallback(async () => {
    if (!shareUrl) return;

    try {
      if (canShare) {
        await navigator.share({
          title: 'My Photobooth Photo',
          text: 'Check out my photo from CloudPlay XP Photobooth!',
          url: shareUrl,
        });
      } else {
        // Fallback to copy link
        await navigator.clipboard.writeText(shareUrl);
        showToast('Link copied to clipboard! 📋');
      }
    } catch (err) {
      console.error('Share failed:', err);
      // Fallback if native share fails/cancelled
      if (canShare) {
         try {
            await navigator.clipboard.writeText(shareUrl);
            showToast('Link copied instead! 📋');
         } catch (e) {
            console.error('Copy failed:', e);
         }
      }
    }
  }, [shareUrl, canShare, showToast]);

  const handlePrint = useCallback(() => {
    if (!downloadUrl) return;
    
    // Open image in new window and print
    const printWindow = window.open(downloadUrl, '_blank');
    if (printWindow) {
      printWindow.onload = () => {
        printWindow.print();
      };
    }
  }, [downloadUrl]);

  if (!isReady) {
    return null;
  }

  return (
    <div className={styles.container}>
      {/* Action Buttons */}
      <div className={styles.actionGrid}>
        {/* Download */}
        <button
          className={styles.actionButton}
          onClick={handleDownload}
          disabled={!downloadUrl}
        >
          <span className={styles.actionIcon}>⬇️</span>
          <span className={styles.actionLabel}>Download</span>
        </button>

        {/* Print */}
        <button
          className={styles.actionButton}
          onClick={handlePrint}
          disabled={!downloadUrl}
        >
          <span className={styles.actionIcon}>🖨️</span>
          <span className={styles.actionLabel}>Print</span>
        </button>

        {/* Share / Copy Link */}
        <button
          className={styles.actionButton}
          onClick={handleShare}
          disabled={!shareUrl}
        >
          <span className={styles.actionIcon}>{canShare ? '📤' : '🔗'}</span>
          <span className={styles.actionLabel}>{canShare ? 'Share' : 'Copy Link'}</span>
        </button>
      </div>

      {/* QR Code */}
      {shareUrl && (
        <div className={styles.qrSection}>
          <p className={styles.qrLabel}>Scan to download on your phone</p>
          <div className={styles.qrContainer}>
            <QRCodeSVG 
              value={shareUrl}
              size={140}
              level="M"
              bgColor="transparent"
              fgColor="#ffffff"
              includeMargin={false}
            />
          </div>
        </div>
      )}

      {/* Toast Notification */}
      {toastMessage && (
        <div className={styles.toast}>
          {toastMessage}
        </div>
      )}
    </div>
  );
}
