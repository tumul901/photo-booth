'use client';

import type { WordItem } from '@/types/wtm';
import styles from './WordTile.module.css';

interface WordTileProps {
  word: WordItem;
  isSelected: boolean;
  isDisabled: boolean;
  onToggle: (wordId: string) => void;
}

export default function WordTile({ word, isSelected, isDisabled, onToggle }: WordTileProps) {
  const label = word.label;
  const truncated = label.length > 15;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!isDisabled) onToggle(word.id);
    }
  };

  return (
    <div
      role="button"
      aria-pressed={isSelected}
      aria-disabled={isDisabled}
      tabIndex={isDisabled ? -1 : 0}
      title={truncated ? label : undefined}
      className={`${styles.tile} ${isSelected ? styles.selected : ''} ${isDisabled ? styles.disabled : ''}`}
      onClick={() => !isDisabled && onToggle(word.id)}
      onKeyDown={handleKeyDown}
    >
      {isSelected && <span className={styles.check}>✓</span>}
      <span className={styles.label}>{truncated ? label.slice(0, 14) + '…' : label}</span>
    </div>
  );
}
