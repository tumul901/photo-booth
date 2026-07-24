"use client";

import { useEffect } from 'react';
import styles from './LightboxModal.module.css';

interface QRModalProps {
  outputId: string;
  apiBaseUrl: string;
  onClose: () => void;
}

export default function QRModal({ outputId, apiBaseUrl, onClose }: QRModalProps) {
  // The customer-facing download URL — deliberately no ?source=app so the scan
  // doesn't set downloaded_at (only operator-initiated downloads do that).
  const customerUrl = `${apiBaseUrl}/api/download/${outputId}`;
  // QR encoded via a free, privacy-safe public API (no data leaves besides the URL string)
  const qrSrc = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(customerUrl)}`;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
      <div className={styles.content} onClick={(e) => e.stopPropagation()} style={{ maxWidth: 360 }}>
        <div className={styles.bar} style={{ flexDirection: 'column', alignItems: 'center', gap: '1rem', padding: '1.5rem' }}>
          <p style={{ margin: 0, color: '#aaa', fontSize: '0.85rem', textAlign: 'center' }}>
            Ask the guest to scan this QR code with their phone to download their photo.
          </p>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={qrSrc} alt="QR code" width={280} height={280} style={{ borderRadius: 8, background: '#fff', padding: 8 }} />
          <p style={{ margin: 0, color: '#666', fontSize: '0.75rem', wordBreak: 'break-all', textAlign: 'center' }}>
            {customerUrl}
          </p>
        </div>
      </div>
    </div>
  );
}
