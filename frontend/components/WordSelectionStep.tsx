'use client';

import { useState, useEffect, useCallback } from 'react';
import type { WordsPayload } from '@/types/wtm';
import { fetchWords, composeTemplate } from '@/api/wtm';
import { useWordSelection } from '@/hooks/useWordSelection';
import SelectionCounter from './SelectionCounter';
import BundleRow from './BundleRow';
import WordGrid from './WordGrid';
import styles from './WordSelectionStep.module.css';

interface WordSelectionStepProps {
  templateId: string;
  onConfirm: (composedTemplatePath: string, name: string, designation: string) => void;
  onBack: () => void;
}

export default function WordSelectionStep({ templateId, onConfirm, onBack }: WordSelectionStepProps) {
  const [fetchState, setFetchState] = useState<'loading' | 'success' | 'error'>('loading');
  const [wordsPayload, setWordsPayload] = useState<WordsPayload | null>(null);
  const [composeState, setComposeState] = useState<'idle' | 'loading' | 'error'>('idle');
  const [composeError, setComposeError] = useState<string | null>(null);
  const [wtmName, setWtmName] = useState('');
  const [wtmDesignation, setWtmDesignation] = useState('');

  const { selected, toggle, selectBundle, effectiveMax } = useWordSelection(
    wordsPayload?.max_selections ?? 6,
    wordsPayload?.slot_count ?? 6,
  );

  const loadWords = useCallback(async () => {
    setFetchState('loading');
    try {
      const data = await fetchWords(templateId);
      setWordsPayload(data);
      setFetchState('success');
    } catch {
      setFetchState('error');
    }
  }, [templateId]);

  useEffect(() => {
    loadWords();
  }, [loadWords]);

  const handleConfirm = async () => {
    if (selected.length === 0 || !wordsPayload) return;
    setComposeState('loading');
    setComposeError(null);
    try {
      const result = await composeTemplate({
        template_id: templateId,
        selected_words: selected,
      });
      onConfirm(result.template_path, wtmName.trim(), wtmDesignation.trim());
    } catch (e: any) {
      setComposeError(e.message || 'Something went wrong. Please try again.');
      setComposeState('error');
    }
  };

  if (fetchState === 'loading') {
    return (
      <div className={styles.centered}>
        <p className={styles.loading}>Loading words…</p>
        <button className={styles.backButton} onClick={onBack} style={{ marginTop: '1rem' }}>
          ←<span className={styles.backText}> Back</span>
        </button>
      </div>
    );
  }

  if (fetchState === 'error') {
    return (
      <div className={styles.centered}>
        <p className={styles.errorText}>Could not load words. Please try again.</p>
        <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
          <button className={styles.backButton} onClick={onBack}>
            ←<span className={styles.backText}> Back</span>
          </button>
          <button className={styles.retryButton} onClick={loadWords}>Retry</button>
        </div>
      </div>
    );
  }

  if (!wordsPayload || wordsPayload.words.length === 0) {
    return (
      <div className={styles.centered}>
        <p className={styles.emptyText}>No words available for this template.</p>
        <button className={styles.backButton} onClick={onBack}>
          ←<span className={styles.backText}> Back</span>
        </button>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <h2 className={styles.title}>Choose Your Words</h2>
        <div className={styles.counterWrapper}>
          <SelectionCounter selected={selected.length} max={effectiveMax} />
        </div>
      </header>

      {wordsPayload.bundles.length > 0 && (
        <BundleRow
          bundles={wordsPayload.bundles}
          selectedWords={selected}
          onSelectBundle={selectBundle}
        />
      )}

      <div
        className={styles.gridWrapper}
        style={{ pointerEvents: composeState === 'loading' ? 'none' : 'auto' }}
      >
        <WordGrid
          words={wordsPayload.words}
          selectedIds={selected}
          effectiveMax={effectiveMax}
          onToggle={toggle}
        />
      </div>

      {(wordsPayload.has_name_overlay || wordsPayload.has_designation_overlay) && (
        <div className={styles.textOverlays}>
          {wordsPayload.has_name_overlay && (
            <input
              className={styles.overlayInput}
              type="text"
              placeholder="Your name (optional)"
              value={wtmName}
              onChange={e => setWtmName(e.target.value)}
              disabled={composeState === 'loading'}
            />
          )}
          {wordsPayload.has_designation_overlay && (
            <input
              className={styles.overlayInput}
              type="text"
              placeholder="Your designation (optional)"
              value={wtmDesignation}
              onChange={e => setWtmDesignation(e.target.value)}
              disabled={composeState === 'loading'}
            />
          )}
        </div>
      )}

      {composeState === 'error' && composeError && (
        <div role="alert" className={styles.errorBanner}>
          {composeError}
        </div>
      )}

      <footer className={styles.footer}>
        <button
          className={styles.backButton}
          onClick={onBack}
          disabled={composeState === 'loading'}
        >
          ←<span className={styles.backText}> Back</span>
        </button>
        <button
          className={styles.confirmButton}
          onClick={handleConfirm}
          disabled={selected.length === 0 || composeState === 'loading'}
          aria-disabled={selected.length === 0 || composeState === 'loading'}
        >
          {composeState === 'loading' ? 'Creating your template…' : 'Confirm →'}
        </button>
      </footer>
    </div>
  );
}
