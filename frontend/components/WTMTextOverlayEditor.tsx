"use client";

import React, { useState, useEffect } from 'react';
import styles from './WTMTextOverlayEditor.module.css';
import { WTMTemplateConfig, TextOverlayConfig } from '@/types/wtm';

interface FontItem {
  name: string;
  path: string;
}

interface WTMTextOverlayEditorProps {
  config: WTMTemplateConfig;
  apiBaseUrl: string;
}

const EMPTY_OVERLAY: TextOverlayConfig = {
  x: 100,
  y: 100,
  font_size: 60,
  color: '#ffffff',
  font_name: '',
  max_width: 0,
  align: 'left',
  uppercase: false,
};

export default function WTMTextOverlayEditor({ config, apiBaseUrl }: WTMTextOverlayEditorProps) {
  const [fonts, setFonts] = useState<FontItem[]>([]);
  const [nameEnabled, setNameEnabled] = useState(!!config.name_text);
  const [nameCfg, setNameCfg] = useState<TextOverlayConfig>(config.name_text ?? { ...EMPTY_OVERLAY });
  const [desigEnabled, setDesigEnabled] = useState(!!config.designation_text);
  const [desigCfg, setDesigCfg] = useState<TextOverlayConfig>(config.designation_text ?? { ...EMPTY_OVERLAY });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);

  useEffect(() => {
    fetch(`${apiBaseUrl}/api/admin/wtm/fonts`)
      .then(r => r.json())
      .then(d => setFonts(d.fonts ?? []))
      .catch(() => {});
  }, [apiBaseUrl]);

  const putOverlay = async (field: 'name_text' | 'designation_text', enabled: boolean, cfg: TextOverlayConfig) => {
    const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${config.template_id}/text-overlay`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ field, config: enabled ? cfg : null }),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.detail?.message ?? d.detail ?? 'Save failed');
    }
  };

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    setSavedOk(false);
    try {
      await putOverlay('name_text', nameEnabled, nameCfg);
      await putOverlay('designation_text', desigEnabled, desigCfg);
      setSavedOk(true);
      setTimeout(() => setSavedOk(false), 3000);
    } catch (e: any) {
      setSaveError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const renderSection = (
    label: string,
    enabled: boolean,
    setEnabled: (v: boolean) => void,
    cfg: TextOverlayConfig,
    setCfg: (v: TextOverlayConfig) => void,
  ) => (
    <div className={styles.section}>
      <label className={styles.enableRow}>
        <input
          type="checkbox"
          checked={enabled}
          onChange={e => setEnabled(e.target.checked)}
        />
        <span className={styles.sectionLabel}>{label}</span>
      </label>

      {enabled && (
        <div className={styles.fields}>
          <div className={styles.row}>
            <label>X</label>
            <input type="number" value={cfg.x}
              onChange={e => setCfg({ ...cfg, x: parseInt(e.target.value) || 0 })} />
          </div>
          <div className={styles.row}>
            <label>Y</label>
            <input type="number" value={cfg.y}
              onChange={e => setCfg({ ...cfg, y: parseInt(e.target.value) || 0 })} />
          </div>
          <div className={styles.row}>
            <label>Font size</label>
            <input type="number" value={cfg.font_size}
              onChange={e => setCfg({ ...cfg, font_size: parseInt(e.target.value) || 60 })} />
          </div>
          <div className={styles.row}>
            <label>Color</label>
            <div className={styles.colorRow}>
              <input type="color" value={cfg.color}
                onChange={e => setCfg({ ...cfg, color: e.target.value })} />
              <span>{cfg.color}</span>
            </div>
          </div>
          <div className={styles.row}>
            <label>Font</label>
            <select value={cfg.font_name}
              onChange={e => setCfg({ ...cfg, font_name: e.target.value })}>
              <option value="">Default</option>
              {fonts.map(f => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </select>
          </div>
          <div className={styles.row}>
            <label>Max width <small>(0 = none)</small></label>
            <input type="number" value={cfg.max_width}
              onChange={e => setCfg({ ...cfg, max_width: parseInt(e.target.value) || 0 })} />
          </div>
          <div className={styles.row}>
            <label>Align</label>
            <select value={cfg.align}
              onChange={e => setCfg({ ...cfg, align: e.target.value as TextOverlayConfig['align'] })}>
              <option value="left">Left</option>
              <option value="center">Center</option>
              <option value="right">Right</option>
            </select>
          </div>
          <div className={styles.row}>
            <label>Uppercase</label>
            <input type="checkbox" checked={cfg.uppercase}
              onChange={e => setCfg({ ...cfg, uppercase: e.target.checked })} />
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className={styles.container}>
      <h3 className={styles.heading}>Text Overlays — {config.name}</h3>
      <p className={styles.hint}>Coordinates are in original image pixels (before any scaling).</p>

      {renderSection('Name Text', nameEnabled, setNameEnabled, nameCfg, setNameCfg)}
      {renderSection('Designation Text', desigEnabled, setDesigEnabled, desigCfg, setDesigCfg)}

      {saveError && <div className={styles.error}>{saveError}</div>}
      {savedOk && <div className={styles.success}>Saved!</div>}

      <button className={styles.saveButton} onClick={handleSave} disabled={saving}>
        {saving ? 'Saving…' : 'Save Overlays'}
      </button>
    </div>
  );
}
