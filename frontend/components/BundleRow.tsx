'use client';

import type { BundleItem } from '@/types/wtm';
import styles from './BundleRow.module.css';

interface BundleRowProps {
  bundles: BundleItem[];
  selectedWords: string[];
  onSelectBundle: (words: string[]) => void;
}

function isBundleActive(bundleWords: string[], selectedWords: string[]): boolean {
  if (bundleWords.length === 0 || selectedWords.length !== bundleWords.length) return false;
  const a = [...bundleWords].sort();
  const b = [...selectedWords].sort();
  return a.every((w, i) => w === b[i]);
}

export default function BundleRow({ bundles, selectedWords, onSelectBundle }: BundleRowProps) {
  return (
    <div className={styles.row}>
      <span className={styles.label}>Quick pick:</span>
      {bundles.map((bundle) => {
        const active = isBundleActive(bundle.words, selectedWords);
        return (
          <button
            key={bundle.id}
            role="button"
            aria-label={`Select ${bundle.label} bundle`}
            aria-pressed={active}
            className={`${styles.chip} ${active ? styles.active : ''}`}
            onClick={() => onSelectBundle(bundle.words)}
          >
            {bundle.label}
          </button>
        );
      })}
    </div>
  );
}
