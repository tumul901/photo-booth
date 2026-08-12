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
  printWidthMm?: number;
  printHeightMm?: number;
  /** Real encoding of the saved file — "png" | "jpg". */
  outputFormat?: string | null;
  /** True when the output carries real alpha (artwork modes). */
  transparent?: boolean | null;
}

export default function DownloadPanel({
  downloadUrl,
  shareUrl,
  outputId,
  isReady,
  printWidthMm,
  printHeightMm,
  outputFormat,
  transparent,
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

  // The extension has to match what the server actually saved. This was
  // hard-coded to .png for every mode, so guests received JPEGs named .png —
  // which some phone galleries refuse to open.
  const ext = (outputFormat || 'jpg').toLowerCase() === 'png' ? 'png' : 'jpg';

  const handleDownload = useCallback(() => {
    if (!downloadUrl) return;

    try {
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `photobooth-${outputId || 'photo'}.${ext}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      showToast(
        transparent
          ? 'Transparent PNG downloading 📥'
          : 'Download started! 📥'
      );
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, [downloadUrl, outputId, ext, transparent, showToast]);

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
    // <img src> loads cross-origin images fine and ignores Content-Disposition: attachment.
    const printWindow = window.open('', '_blank');
    if (!printWindow) return;
    const doc = printWindow.document;
    doc.title = 'Print';
    const style = doc.createElement('style');
    const pageSize = printWidthMm && printHeightMm
      ? `@page{size:${printWidthMm}mm ${printHeightMm}mm;margin:0}`
      : '@media print{body{margin:0}}';
    style.textContent = [
      '*{margin:0;padding:0;box-sizing:border-box}',
      'body{display:flex;justify-content:center;align-items:center;min-height:100vh;background:#fff}',
      'img{max-width:100%;max-height:100vh;object-fit:contain}',
      pageSize,
    ].join('');
    doc.head.appendChild(style);
    const img = doc.createElement('img');
    img.src = downloadUrl;
    img.onload = () => { printWindow.focus(); printWindow.print(); };
    doc.body.appendChild(img);
  }, [downloadUrl, printWidthMm, printHeightMm]);

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
          <span className={styles.actionLabel}>
            {transparent ? 'Download PNG' : 'Download'}
          </span>
        </button>

        {/* Print — hidden for transparent artwork. Printing alpha flattens it
            onto white, which fills the triangle with a white block and looks
            like a broken render rather than the intended cut-out. */}
        {!transparent && (
          <button
            className={styles.actionButton}
            onClick={handlePrint}
            disabled={!downloadUrl}
          >
            <span className={styles.actionIcon}>🖨️</span>
            <span className={styles.actionLabel}>Print</span>
          </button>
        )}

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

      {transparent && (
        <p className={styles.qrLabel}>
          Transparent PNG — the area inside the triangle is see-through, ready to
          drop over video or an animated background.
        </p>
      )}

      {/* QR Code */}
      {shareUrl && (
        <div className={styles.qrSection}>
          <p className={styles.qrLabel}>Scan to download on your phone</p>
          <div className={styles.qrContainer}>
            <QRCodeSVG 
              value={downloadUrl || shareUrl}
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
