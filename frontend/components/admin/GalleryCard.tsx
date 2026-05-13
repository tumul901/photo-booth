"use client";

import { timeAgo } from './timeAgo';
import styles from './GalleryPanel.module.css';

export interface GalleryItem {
  output_id: string;
  filename: string;
  url: string;
  size: number;
  last_modified: string | number;
  template_prefix: string;
  archived: boolean;
}

interface GalleryCardProps {
  item: GalleryItem;
  selectionMode: boolean;
  selected: boolean;
  onToggleSelect: (id: string) => void;
  onDelete: (id: string) => void;
  onArchive: (id: string) => void;
  onUnarchive: (id: string) => void;
  onOpen?: () => void;
}

export default function GalleryCard({
  item,
  selectionMode,
  selected,
  onToggleSelect,
  onDelete,
  onArchive,
  onUnarchive,
  onOpen,
}: GalleryCardProps) {
  const handleClick = () => {
    if (selectionMode) onToggleSelect(item.output_id);
    else onOpen?.();
  };

  return (
    <div
      className={`${styles.card} ${selected ? styles.cardSelected : ''}`}
      onClick={handleClick}
      role={selectionMode ? 'checkbox' : 'button'}
      aria-checked={selectionMode ? selected : undefined}
      style={{ cursor: 'pointer' }}
    >
      <div className={styles.imageWrapper}>
        <img
          src={item.url}
          alt={item.filename}
          className={styles.image}
          loading="lazy"
          decoding="async"
        />
        {selectionMode && (
          <div className={`${styles.checkbox} ${selected ? styles.checkboxChecked : ''}`}>
            {selected && '✓'}
          </div>
        )}
        {!selectionMode && (
          <button
            className={styles.deleteOverlay}
            onClick={(e) => { e.stopPropagation(); onDelete(item.output_id); }}
            title="Delete photo"
          >
            🗑️
          </button>
        )}
      </div>
      <div className={styles.cardInfo}>
        <span
          className={styles.timestamp}
          title={String(item.last_modified)}
        >
          {timeAgo(item.last_modified)}
        </span>
        <div className={styles.cardInfoRight}>
          <span className={styles.size}>{(item.size / 1024).toFixed(0)} KB</span>
          <a
            href={item.url}
            download={item.filename}
            className={styles.downloadBtn}
            onClick={(e) => e.stopPropagation()}
            title="Download"
          >
            Download
          </a>
          {item.archived ? (
            <button
              className={styles.unarchiveBtn}
              onClick={(e) => { e.stopPropagation(); onUnarchive(item.output_id); }}
              title="Restore from archive"
            >
              Restore
            </button>
          ) : (
            <button
              className={styles.archiveBtn}
              onClick={(e) => { e.stopPropagation(); onArchive(item.output_id); }}
              title="Archive"
            >
              Archive
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
