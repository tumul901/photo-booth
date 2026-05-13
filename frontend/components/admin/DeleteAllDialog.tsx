"use client";

import { useState } from 'react';
import styles from './GalleryPanel.module.css';

interface DeleteAllDialogProps {
  totalCount: number;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
}

export default function DeleteAllDialog({
  totalCount,
  onConfirm,
  onCancel,
  busy,
}: DeleteAllDialogProps) {
  const [input, setInput] = useState('');
  const confirmed = input === 'delete';

  return (
    <div className={styles.dialogOverlay} onClick={onCancel}>
      <div className={styles.dialog} onClick={(e) => e.stopPropagation()}>
        <h3 className={styles.dialogTitle}>Delete all {totalCount} photos</h3>
        <p className={styles.dialogBody}>
          This will permanently delete every photo from storage. This cannot be undone.
        </p>
        <p className={styles.dialogBody}>
          To confirm, type <strong>delete</strong> below:
        </p>
        <input
          className={styles.dialogInput}
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="delete"
          autoFocus
        />
        <div className={styles.dialogActions}>
          <button className={styles.btnSecondary} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button
            className={styles.btnDanger}
            onClick={onConfirm}
            disabled={!confirmed || busy}
          >
            {busy ? 'Deleting…' : 'Delete All'}
          </button>
        </div>
      </div>
    </div>
  );
}
