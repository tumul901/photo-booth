"use client";

import React, { useState, useEffect } from 'react';
import styles from './WTMWordManager.module.css';
import { WTMTemplateConfig, WTMWord } from '@/types/wtm';
import WTMBundleManager from './WTMBundleManager';

interface WTMWordManagerProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
  onConfigUpdated: (newConfig: WTMTemplateConfig) => void;
}

interface FontOption { name: string; display: string; }

const WTMWordManager: React.FC<WTMWordManagerProps> = ({ config, apiBaseUrl, onConfigUpdated }) => {
  const [addMode, setAddMode] = useState<'asset' | 'text'>('asset');

  // Asset word state
  const [wordId, setWordId] = useState('');
  const [label, setLabel] = useState('');
  const [assetFile, setAssetFile] = useState<File | null>(null);

  // Text word state
  const [textWordId, setTextWordId] = useState('');
  const [textLabel, setTextLabel] = useState('');
  const [textContent, setTextContent] = useState('');
  const [textFont, setTextFont] = useState('');
  const [textColor, setTextColor] = useState('#1a73e8');
  const [textAlign, setTextAlign] = useState<'left' | 'center' | 'right'>('center');

  const [fonts, setFonts] = useState<FontOption[]>([]);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/admin/wtm/fonts`)
      .then(r => r.json())
      .then(d => {
        setFonts(d.fonts ?? []);
        if (d.fonts?.length && !textFont) setTextFont(d.fonts[0].name);
      })
      .catch(() => {});
  }, [apiBaseUrl]);

  const reloadConfig = async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/config`);
      if (res.ok) onConfigUpdated(await res.json());
    } catch {}
  };

  const resetAssetForm = () => { setWordId(''); setLabel(''); setAssetFile(null); };
  const resetTextForm  = () => { setTextWordId(''); setTextLabel(''); setTextContent(''); setTextColor('#1a73e8'); setTextAlign('center'); };

  const handleAssetFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0] || null;
    if (file) {
      const lower = file.name.toLowerCase();
      if (!lower.endsWith('.svg') && !lower.endsWith('.png')) {
        alert('Only SVG or PNG files are allowed.');
        return;
      }
    }
    setAssetFile(file);
  };

  const handleSubmitAsset = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!wordId || !label || !assetFile) return;
    if (!/^[a-z0-9-]+$/.test(wordId)) { setError('Word ID must be lowercase letters, numbers, and hyphens only.'); return; }

    setIsUploading(true); setError(null);
    const formData = new FormData();
    formData.append('word_id', wordId.trim().toLowerCase());
    formData.append('label', label);
    formData.append('file', assetFile);

    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words`, { method: 'POST', body: formData });
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail?.message || 'Upload failed'); }
      resetAssetForm();
      await reloadConfig();
    } catch (err: any) { setError(err.message); }
    finally { setIsUploading(false); }
  };

  const handleSubmitText = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!textWordId || !textLabel || !textContent || !textFont) return;
    if (!/^[a-z0-9-]+$/.test(textWordId)) { setError('Word ID must be lowercase letters, numbers, and hyphens only.'); return; }

    setIsUploading(true); setError(null);
    const formData = new FormData();
    formData.append('word_id', textWordId.trim().toLowerCase());
    formData.append('label', textLabel);
    formData.append('text', textContent);
    formData.append('font', textFont);
    formData.append('color', textColor);
    formData.append('align', textAlign);

    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words/text`, { method: 'POST', body: formData });
      if (!res.ok) { const d = await res.json(); throw new Error(d.detail?.message || 'Failed to add text word'); }
      resetTextForm();
      await reloadConfig();
    } catch (err: any) { setError(err.message); }
    finally { setIsUploading(false); }
  };

  const handleDelete = async (targetId: string) => {
    if (!confirm(`Delete word "${targetId}"? This will remove it from all bundles.`)) return;
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words/${targetId}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      await reloadConfig();
    } catch (err: any) { alert(err.message); }
  };

  const isTextWord = (w: WTMWord): w is import('@/types/wtm').WTMTextWord => w.type === 'text';

  return (
    <div className={styles.container}>
      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Add New Word</h3>

        {/* Mode toggle */}
        <div className={styles.modeToggle}>
          <button
            className={`${styles.modeBtn} ${addMode === 'asset' ? styles.modeBtnActive : ''}`}
            onClick={() => { setAddMode('asset'); setError(null); }}
            type="button"
          >
            Upload Asset (SVG / PNG)
          </button>
          <button
            className={`${styles.modeBtn} ${addMode === 'text' ? styles.modeBtnActive : ''}`}
            onClick={() => { setAddMode('text'); setError(null); }}
            type="button"
          >
            Render Text
          </button>
        </div>

        <div className={styles.formCard}>
          {addMode === 'asset' ? (
            <form className={styles.formGrid} onSubmit={handleSubmitAsset}>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Word ID</label>
                <input className={styles.input} type="text" placeholder="e.g. happy-birthday"
                  value={wordId} onChange={e => setWordId(e.target.value)} required />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Display Label</label>
                <input className={styles.input} type="text" placeholder="e.g. Happy Birthday!"
                  value={label} onChange={e => setLabel(e.target.value)} required />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Word Asset (SVG or PNG)</label>
                <label className={styles.fileButton}>
                  {assetFile ? `📄 ${assetFile.name}` : 'Upload SVG / PNG'}
                  <input type="file" accept=".svg,.png" onChange={handleAssetFileChange} hidden required />
                </label>
              </div>
              <button className={styles.submitButton} type="submit"
                disabled={isUploading || !wordId || !label || !assetFile}>
                {isUploading ? 'Adding...' : 'Add Word'}
              </button>
            </form>
          ) : (
            <form className={styles.textFormGrid} onSubmit={handleSubmitText}>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Word ID</label>
                <input className={styles.input} type="text" placeholder="e.g. agile"
                  value={textWordId} onChange={e => setTextWordId(e.target.value)} required />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Display Label</label>
                <input className={styles.input} type="text" placeholder="e.g. Agile"
                  value={textLabel} onChange={e => setTextLabel(e.target.value)} required />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Text to Render</label>
                <input className={styles.input} type="text" placeholder="e.g. AGILE"
                  value={textContent} onChange={e => setTextContent(e.target.value)} required />
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Font</label>
                <select className={styles.input} value={textFont} onChange={e => setTextFont(e.target.value)} required>
                  {fonts.length === 0 && <option value="">No fonts found</option>}
                  {fonts.map(f => <option key={f.name} value={f.name}>{f.display}</option>)}
                </select>
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Color</label>
                <div className={styles.colorRow}>
                  <input type="color" className={styles.colorPicker} value={textColor}
                    onChange={e => setTextColor(e.target.value)} />
                  <input className={styles.input} type="text" value={textColor}
                    onChange={e => setTextColor(e.target.value)} style={{ flex: 1 }} />
                </div>
              </div>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Alignment</label>
                <select className={styles.input} value={textAlign}
                  onChange={e => setTextAlign(e.target.value as 'left' | 'center' | 'right')}>
                  <option value="left">Left</option>
                  <option value="center">Center</option>
                  <option value="right">Right</option>
                </select>
              </div>
              {/* Live preview */}
              {textContent && (
                <div className={styles.inputGroup} style={{ gridColumn: '1 / -1' }}>
                  <label className={styles.label}>Preview</label>
                  <div className={styles.textPreviewLarge} style={{ color: textColor, textAlign: textAlign,
                    fontFamily: 'sans-serif' }}>
                    {textContent}
                  </div>
                </div>
              )}
              <button className={styles.submitButton} type="submit"
                disabled={isUploading || !textWordId || !textLabel || !textContent || !textFont}
                style={{ gridColumn: '1 / -1' }}>
                {isUploading ? 'Adding...' : 'Add Text Word'}
              </button>
            </form>
          )}
          {error && <div className={styles.error}>⚠️ {error}</div>}
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Existing Words</h3>
        <div className={styles.wordList}>
          {config.words.map(word => (
            <div key={word.id} className={styles.wordItem}>
              {isTextWord(word) ? (
                <div className={styles.textPreview} style={{ color: word.color }}>
                  <span>{word.text}</span>
                  <span className={styles.textBadge}>T</span>
                </div>
              ) : (
                <div className={styles.svgPreview}>
                  <img src={`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/words/${word.id}/svg`}
                    alt={word.label} />
                </div>
              )}
              <div className={styles.wordInfo}>
                <span className={styles.wordLabel}>{word.label}</span>
                <span className={styles.wordId}>{word.id} · {isTextWord(word) ? `text · ${word.font}` : (word.svg_filename?.endsWith('.png') ? 'png' : 'svg')}</span>
              </div>
              <button className={styles.deleteBtn} onClick={() => handleDelete(word.id)} title="Delete word">🗑️</button>
            </div>
          ))}
          {config.words.length === 0 && (
            <div className={styles.noWords}>No words added yet. Add your first word above.</div>
          )}
        </div>
      </div>

      <hr style={{ opacity: 0.1, margin: '1rem 0' }} />

      <WTMBundleManager config={config} apiBaseUrl={apiBaseUrl} onConfigUpdated={onConfigUpdated} />
    </div>
  );
};

export default WTMWordManager;
