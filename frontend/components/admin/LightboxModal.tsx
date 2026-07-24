"use client";

import { useEffect, useCallback } from 'react';
import type { GalleryItem } from './GalleryPanel';
import styles from './LightboxModal.module.css';

interface LightboxModalProps {
  items: GalleryItem[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onDelete: (id: string) => void;
}

export default function LightboxModal({ items, index, onClose, onNavigate, onDelete }: LightboxModalProps) {
  const item = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
    if (e.key === 'ArrowLeft' && hasPrev) onNavigate(index - 1);
    if (e.key === 'ArrowRight' && hasNext) onNavigate(index + 1);
  }, [onClose, onNavigate, index, hasPrev, hasNext]);

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  if (!item) return null;

  return (
    <div className={styles.overlay} onClick={onClose} role="dialog" aria-modal="true">
      <button className={styles.closeBtn} onClick={onClose} aria-label="Close">✕</button>
      <span className={styles.counter}>{index + 1} / {items.length}</span>

      <button
        className={`${styles.navBtn} ${styles.prevBtn}`}
        onClick={(e) => { e.stopPropagation(); onNavigate(index - 1); }}
        disabled={!hasPrev}
        aria-label="Previous photo"
      >‹</button>

      <div className={styles.content} onClick={(e) => e.stopPropagation()}>
        <img src={item.url} alt={item.filename} className={styles.image} />
        <div className={styles.bar}>
          <div className={styles.meta}>
            {item.guest_name && <span style={{ fontWeight: 600, color: '#fff' }}>{item.guest_name}</span>}
            {item.guest_phone && <span style={{ color: '#aaa' }}>{item.guest_phone}</span>}
            <span>{(item.size / 1024).toFixed(0)} KB</span>
            {item.template_prefix && (
              <span className={styles.template}>{item.template_prefix}</span>
            )}
            {item.downloaded_at && (
              <span style={{ color: '#34d399', fontSize: '0.8rem' }}>Handed over</span>
            )}
          </div>
          <div className={styles.actions}>
            <a
              href={item.download_url || `${item.url}?source=app`}
              download={item.filename}
              className={styles.downloadBtn}
              onClick={(e) => e.stopPropagation()}
            >
              ↓ Download
            </a>
            <button
              className={styles.deleteBtn}
              onClick={() => onDelete(item.output_id)}
            >
              🗑️ Delete
            </button>
          </div>
        </div>
      </div>

      <button
        className={`${styles.navBtn} ${styles.nextBtn}`}
        onClick={(e) => { e.stopPropagation(); onNavigate(index + 1); }}
        disabled={!hasNext}
        aria-label="Next photo"
      >›</button>
    </div>
  );
}
