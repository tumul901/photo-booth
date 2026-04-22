'use client';

import type { WordItem } from '@/types/wtm';
import WordTile from './WordTile';
import styles from './WordGrid.module.css';

interface WordGridProps {
  words: WordItem[];
  selectedIds: string[];
  effectiveMax: number;
  onToggle: (wordId: string) => void;
}

export default function WordGrid({ words, selectedIds, effectiveMax, onToggle }: WordGridProps) {
  return (
    <div className={styles.grid}>
      {words.map((word) => {
        const isSelected = selectedIds.includes(word.id);
        const isDisabled = !isSelected && selectedIds.length >= effectiveMax;
        return (
          <WordTile
            key={word.id}
            word={word}
            isSelected={isSelected}
            isDisabled={isDisabled}
            onToggle={onToggle}
          />
        );
      })}
    </div>
  );
}
