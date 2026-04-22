"use client";

import React, { useState, useEffect } from 'react';
import styles from './WTMBundleManager.module.css';
import { WTMTemplateConfig, WTMBundle } from '@/types/wtm';

interface WTMBundleManagerProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onConfigUpdated: (newConfig: WTMTemplateConfig) => void;
}

const WTMBundleManager: React.FC<WTMBundleManagerProps> = ({ config, apiBaseUrl, onConfigUpdated }) => {
  const [bundles, setBundles] = useState<WTMBundle[]>(config.bundles);
  const [isDirty, setIsDirty] = useState(false);
  const [newBundleLabel, setNewBundleLabel] = useState('');
  const [selectedWordIds, setSelectedWordIds] = useState<string[]>([]);
  const [isSaving, setIsSaving] = useState(false);

  // Sync state if config changes externally (e.g. after a save)
  useEffect(() => {
    setBundles(config.bundles);
    setIsDirty(false);
  }, [config.bundles]);

  const toggleWord = (wordId: string) => {
    setSelectedWordIds(prev => {
      if (prev.includes(wordId)) {
        return prev.filter(id => id !== wordId);
      }
      if (prev.length >= 6) {
        alert("A bundle can have maximum 6 words.");
        return prev;
      }
      return [...prev, wordId];
    });
  };

  const handleAddBundle = () => {
    if (!newBundleLabel || selectedWordIds.length === 0) return;
    
    const bundleId = newBundleLabel.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
    
    // Check for duplicate ID
    if (bundles.some(b => b.id === bundleId)) {
      alert(`A bundle with ID "${bundleId}" already exists.`);
      return;
    }

    const newBundle: WTMBundle = {
      id: bundleId,
      label: newBundleLabel,
      words: [...selectedWordIds]
    };

    setBundles(prev => [...prev, newBundle]);
    setNewBundleLabel('');
    setSelectedWordIds([]);
    setIsDirty(true);
  };

  const handleDeleteBundle = (bundleId: string) => {
    setBundles(prev => prev.filter(b => b.id !== bundleId));
    setIsDirty(true);
  };

  const handleSaveAll = async () => {
    setIsSaving(true);
    try {
      const res = await fetch(
        `${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/bundles`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ bundles })
        }
      );
      if (!res.ok) throw new Error('Failed to save bundles');
      
      // Reload config
      const configRes = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/config`);
      if (configRes.ok) {
        const newConfig = await configRes.json();
        onConfigUpdated(newConfig);
      }
      alert('Bundles saved successfully!');
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsSaving(false);
    }
  };

  const getWordLabel = (id: string) => {
    return config.words.find(w => w.id === id)?.label || id;
  };

  if (config.words.length === 0) {
    return (
      <div className={styles.container}>
        <div className={styles.noBundles}>
          ⚠️ Add words first before creating bundles.
        </div>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.sectionHeader}>
        <h3 className={styles.sectionTitle}>🛍️ Manage Bundles</h3>
        <p style={{fontSize: '0.85rem', color: '#64748b', marginTop: '0.25rem'}}>
          Bundles allow guests to pick a themed set of words (e.g., "Birthday Pack") in one click.
        </p>
      </div>

      <div className={styles.formCard}>
        <div className={styles.formGrid}>
          <div className={styles.inputGroup}>
            <label className={styles.label}>Bundle Name (e.g. Wedding Pack)</label>
            <input 
              className={styles.input}
              type="text" 
              placeholder="Enter bundle name..."
              value={newBundleLabel}
              onChange={(e) => setNewBundleLabel(e.target.value)}
            />
          </div>
          <button 
            className={styles.submitButton}
            onClick={handleAddBundle}
            disabled={!newBundleLabel || selectedWordIds.length === 0}
          >
            Add to List
          </button>
        </div>

        <div className={styles.inputGroup}>
          <label className={styles.label}>Select Words (Max 6)</label>
          <div className={styles.wordChecklist}>
            {config.words.map(word => {
              const checked = selectedWordIds.includes(word.id);
              const disabled = !checked && selectedWordIds.length >= 6;
              return (
                <label key={word.id} className={`${styles.checkItem} ${disabled ? styles.disabled : ''}`}>
                  <input 
                    type="checkbox" 
                    checked={checked}
                    onChange={() => toggleWord(word.id)}
                    disabled={disabled}
                  />
                  <span>{word.label}</span>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className={styles.bundleList}>
        {bundles.map(bundle => (
          <div key={bundle.id} className={styles.bundleCard}>
            <div className={styles.bundleHeader}>
              <span className={styles.bundleLabel}>{bundle.label}</span>
              <button 
                className={styles.deleteBtn}
                onClick={() => handleDeleteBundle(bundle.id)}
              >
                🗑️
              </button>
            </div>
            <div className={styles.wordChips}>
              {bundle.words.map(wid => (
                <span key={wid} className={styles.chip}>{getWordLabel(wid)}</span>
              ))}
            </div>
          </div>
        ))}
        {bundles.length === 0 && (
          <div className={styles.noBundles} style={{gridColumn: '1/-1'}}>
            No bundles defined for this template.
          </div>
        )}
      </div>

      <div className={styles.saveAllArea}>
        {isDirty && <span className={styles.dirtyHint}>⚠️ You have unsaved changes in bundles</span>}
        <button 
          className={styles.saveAllButton}
          onClick={handleSaveAll}
          disabled={!isDirty || isSaving}
        >
          {isSaving ? 'Saving Changes...' : 'Save All Bundles'}
        </button>
      </div>
    </div>
  );
};

export default WTMBundleManager;
