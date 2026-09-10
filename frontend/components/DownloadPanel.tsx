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

// Inline SVGs rather than an icon library — a handful of glyphs are needed,
// so a dependency would outweigh what it buys. `currentColor` picks up each
// button's existing text color, so no separate color prop to thread through.
function DownloadIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3v12" />
      <polyline points="7 10 12 15 17 10" />
      <path d="M5 21h14" />
    </svg>
  );
}

function PrinterIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 6 3 18 3 18 9" />
      <rect x="4" y="9" width="16" height="8" rx="1" />
      <path d="M6 17v4h12v-4" />
    </svg>
  );
}

function ShareIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="18" cy="5" r="3" />
      <circle cx="6" cy="12" r="3" />
      <circle cx="18" cy="19" r="3" />
      <line x1="8.6" y1="10.5" x2="15.4" y2="6.5" />
      <line x1="8.6" y1="13.5" x2="15.4" y2="17.5" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 17H7a5 5 0 0 1 0-10h2" />
      <path d="M15 7h2a5 5 0 0 1 0 10h-2" />
      <line x1="8" y1="12" x2="16" y2="12" />
    </svg>
  );
}

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
          ? 'Transparent PNG downloading'
          : 'Download started!'
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
        showToast('Link copied to clipboard!');
      }
    } catch (err) {
      console.error('Share failed:', err);
      // Fallback if native share fails/cancelled
      if (canShare) {
         try {
            await navigator.clipboard.writeText(shareUrl);
            showToast('Link copied instead!');
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
          <span className={styles.actionIcon}><DownloadIcon /></span>
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
            <span className={styles.actionIcon}><PrinterIcon /></span>
            <span className={styles.actionLabel}>Print</span>
          </button>
        )}

        {/* Share / Copy Link */}
        <button
          className={styles.actionButton}
          onClick={handleShare}
          disabled={!shareUrl}
        >
          <span className={styles.actionIcon}>{canShare ? <ShareIcon /> : <LinkIcon />}</span>
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
              fgColor="#2E5A2D"
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
