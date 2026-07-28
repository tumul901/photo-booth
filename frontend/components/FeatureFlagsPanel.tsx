'use client';

/**
 * FeatureFlagsPanel
 * =================
 * Flat list of feature toggles:
 *  - One on/off switch per booth mode (frame, sticker, word_template, magazine)
 *  - Radio for the rembg model profile — local models and the fal.ai cloud
 *    BiRefNet variants — for A/B comparison
 *
 * Writes go to PUT /api/admin/feature-flags. The booth reads them on every load,
 * so changes take effect on the next session — no restart.
 */

import { useEffect, useState } from 'react';
import styles from './FeatureFlagsPanel.module.css';

interface FeatureFlagsPanelProps {
  apiBaseUrl: string;
}

type Mode = 'frame' | 'sticker' | 'word_template' | 'magazine';

interface Flags {
  modes: Record<Mode, boolean>;
  rembg_profile: string;
  sticker_effect: string;
  sticker_stroke_color: string;
  sticker_stroke_width: number;
  capture_form: boolean;
  edge_cleanup: boolean;
}

const MODE_LABELS: Array<{ key: Mode; label: string; hint: string }> = [
  { key: 'frame', label: 'Frame Mode', hint: 'Photo inside a fixed frame' },
  { key: 'sticker', label: 'Sticker Mode', hint: 'Remove background, place on template' },
  { key: 'word_template', label: 'Word Template (WTM)', hint: 'Doodle template + selectable words' },
  { key: 'magazine', label: 'Magazine Cover', hint: 'BG → user cutout → FG sandwich' },
];

const PROFILE_DETAIL: Record<string, { label: string; desc: string }> = {
  human_hi: {
    label: 'human_hi (local — safe fallback)',
    desc: 'u2net_human_seg on this machine. No internet needed and the fastest (~0.5 s), but coarser hair and edges than the cloud models. Switch here to run fully offline, or if a cloud profile ever misbehaves mid-event.',
  },
  isnet_hi: {
    label: 'isnet_hi',
    desc: 'isnet-general-use at 1200 px. Sharper edges (hair, turban, collar). ~+1 s per cutout vs silueta.',
  },
  silueta_hi: {
    label: 'silueta_hi',
    desc: 'silueta at 1600 px. Faster, coarser edges. Good for full-body where edges matter less.',
  },
  cloud_birefnet_portrait: {
    label: '☁ BiRefNet Portrait (fal.ai)',
    desc: 'GPU BiRefNet tuned for portraits — a generation ahead of the local models on hair and fine edges. ~2–4 s per cutout, well under ₹1. Falls back to human_hi automatically if fal.ai is unreachable.',
  },
  cloud_birefnet_matting: {
    label: '☁ BiRefNet Matting (fal.ai) — recommended',
    desc: 'GPU BiRefNet trained on human matting data — the best all-rounder for a people booth, and the most forgiving when guests hold props or crowd the frame. ~2–4 s per cutout. Falls back to human_hi automatically if fal.ai is unreachable.',
  },
  cloud_birefnet_general: {
    label: '☁ BiRefNet General, Heavy (fal.ai)',
    desc: 'GPU BiRefNet general-purpose heavy variant. Most robust when the shot is not a clean portrait — props, several people, odd framing.',
  },
};

const EFFECT_DETAIL: Record<string, { label: string; desc: string }> = {
  none: {
    label: 'None',
    desc: 'Raw cutout — no post-processing. Fastest. Use this as the baseline.',
  },
  stroke: {
    label: 'Outline Stroke',
    desc: 'Colored outline around the cutout (sticker look). ~+5 ms. Color configurable below.',
  },
  shadow: {
    label: 'Drop Shadow',
    desc: 'Soft black shadow behind the cutout. ~+10 ms. Adds depth, hides minor edge issues.',
  },
  unsharp: {
    label: 'Unsharp Mask',
    desc: 'Sharpens RGB to recover detail lost in segmentation downscale. ~+15 ms. Subtle.',
  },
  alpha_matting: {
    label: 'Alpha Matting',
    desc: "rembg's built-in edge refinement. Best quality on hair/fine detail, but +2–5 s per cutout.",
  },
};

export default function FeatureFlagsPanel({ apiBaseUrl }: FeatureFlagsPanelProps) {
  const [flags, setFlags] = useState<Flags | null>(null);
  const [profiles, setProfiles] = useState<string[]>([]);
  const [effects, setEffects] = useState<string[]>([]);
  // Assume configured until the API says otherwise, so the warning never flashes on load.
  const [cloudConfigured, setCloudConfigured] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    fetch(`${apiBaseUrl}/api/admin/feature-flags`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        if (!active) return;
        setFlags(data.flags);
        setProfiles(data.available_rembg_profiles || []);
        setEffects(data.available_sticker_effects || []);
        setCloudConfigured(data.cloud_rembg_configured !== false);
        setError(null);
      })
      .catch((e) => {
        if (active) setError(e.message || 'Failed to load flags');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [apiBaseUrl]);

  const persist = async (update: Partial<Flags>) => {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/feature-flags`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(update),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.detail || `HTTP ${res.status}`);
      }
      const data = await res.json();
      setFlags(data.flags);
      setSavedAt(Date.now());
    } catch (e: any) {
      setError(e.message || 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const toggleMode = (key: Mode) => {
    if (!flags) return;
    persist({ modes: { ...flags.modes, [key]: !flags.modes[key] } });
  };

  const selectProfile = (name: string) => {
    if (!flags || flags.rembg_profile === name) return;
    persist({ rembg_profile: name } as any);
  };

  const selectEffect = (name: string) => {
    if (!flags || flags.sticker_effect === name) return;
    persist({ sticker_effect: name } as any);
  };

  // Draft state for stroke settings — only persisted on explicit Save
  const [draftColor, setDraftColor] = useState<string | null>(null);
  const [draftWidth, setDraftWidth] = useState<number | null>(null);

  const savedColor = flags?.sticker_stroke_color || '#FFFFFF';
  const savedWidth = flags?.sticker_stroke_width ?? 4;
  const strokeIsDirty =
    (draftColor !== null && draftColor !== savedColor) ||
    (draftWidth !== null && draftWidth !== savedWidth);

  const saveStrokeSettings = () => {
    if (!flags) return;
    const update: any = {};
    if (draftColor !== null) update.sticker_stroke_color = draftColor;
    if (draftWidth !== null) update.sticker_stroke_width = draftWidth;
    if (Object.keys(update).length > 0) persist(update);
    setDraftColor(null);
    setDraftWidth(null);
  };

  const cancelStrokeSettings = () => {
    setDraftColor(null);
    setDraftWidth(null);
  };

  if (loading) return <div className={styles.loading}>Loading feature flags…</div>;
  if (error) return <div className={styles.error}>⚠️ {error}</div>;
  if (!flags) return null;

  const recentlySaved = savedAt && Date.now() - savedAt < 2000;

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Feature Toggles</h2>
        {saving && <span className={styles.statusSaving}>Saving…</span>}
        {!saving && recentlySaved && <span className={styles.statusSaved}>✓ Saved</span>}
      </div>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Booth Modes</h3>
        <p className={styles.sectionHint}>
          Disabled modes are hidden from the booth start screen.
        </p>
        <div className={styles.list}>
          {MODE_LABELS.map(({ key, label, hint }) => {
            const on = flags.modes[key] !== false;
            return (
              <label key={key} className={styles.row}>
                <div className={styles.rowText}>
                  <span className={styles.rowLabel}>{label}</span>
                  <span className={styles.rowHint}>{hint}</span>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={on}
                  className={`${styles.toggle} ${on ? styles.toggleOn : ''}`}
                  onClick={() => toggleMode(key)}
                  disabled={saving}
                >
                  <span className={styles.toggleKnob} />
                </button>
              </label>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Background Removal Profile</h3>
        <p className={styles.sectionHint}>
          Swap models live for A/B comparison. Watch <code>PERF [rembg]</code> and <code>QUAL [rembg]</code> in backend logs to compare timing + edge metrics — the{' '}
          <code>source=</code> field says whether a ☁ cloud profile actually reached fal.ai or fell back to local.
        </p>
        {!cloudConfigured && (
          <p className={styles.cloudWarning}>
            ⚠️ No <code>FAL_KEY</code> configured — the ☁ cloud profiles below will fall back to{' '}
            <strong>human_hi</strong> on every photo. Add <code>FAL_KEY</code> to <code>backend/.env</code>{' '}
            and restart the backend to enable them.
          </p>
        )}
        <div className={styles.list}>
          {profiles.map((name) => {
            const detail = PROFILE_DETAIL[name] || { label: name, desc: '' };
            const active = flags.rembg_profile === name;
            return (
              <button
                key={name}
                type="button"
                className={`${styles.profileRow} ${active ? styles.profileActive : ''}`}
                onClick={() => selectProfile(name)}
                disabled={saving}
              >
                <span className={styles.radioDot}>
                  <span className={`${styles.radioDotInner} ${active ? styles.radioDotOn : ''}`} />
                </span>
                <div className={styles.rowText}>
                  <span className={styles.rowLabel}>{detail.label}</span>
                  <span className={styles.rowHint}>{detail.desc}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Edge Cleanup</h3>
        <p className={styles.sectionHint}>
          Removes the colored halo/bleed and stray segmentation ghosts after background
          removal — works on any background (no green screen needed). Adds ~150&nbsp;ms.
          Leave ON unless comparing.
        </p>
        <div className={styles.list}>
          <label className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>Decontaminate edges &amp; drop ghosts</span>
              <span className={styles.rowHint}>
                {flags.edge_cleanup
                  ? 'ON — edge ring recolored to the subject, faint leftover blobs removed'
                  : 'OFF — raw cutout from the model'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={flags.edge_cleanup}
              className={`${styles.toggle} ${flags.edge_cleanup ? styles.toggleOn : ''}`}
              onClick={() => persist({ edge_cleanup: !flags.edge_cleanup } as any)}
              disabled={saving}
            >
              <span className={styles.toggleKnob} />
            </button>
          </label>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Capture Form</h3>
        <p className={styles.sectionHint}>
          When enabled, the booth shows a name + phone number form before the session starts.
          Toggle off between events so guests aren&apos;t prompted unnecessarily.
        </p>
        <div className={styles.list}>
          <label className={styles.row}>
            <div className={styles.rowText}>
              <span className={styles.rowLabel}>Collect name &amp; phone</span>
              <span className={styles.rowHint}>
                {flags.capture_form ? 'Form is ON — guests will be asked for name and phone' : 'Form is OFF — booth proceeds directly to mode selection'}
              </span>
            </div>
            <button
              type="button"
              role="switch"
              aria-checked={flags.capture_form}
              className={`${styles.toggle} ${flags.capture_form ? styles.toggleOn : ''}`}
              onClick={() => persist({ capture_form: !flags.capture_form } as any)}
              disabled={saving}
            >
              <span className={styles.toggleKnob} />
            </button>
          </label>
        </div>
      </section>

      <section className={styles.section}>
        <h3 className={styles.sectionTitle}>Sticker Edge Effect</h3>
        <p className={styles.sectionHint}>
          Applied after background removal. One at a time. Look for <code>effect=</code> in the <code>PERF [rembg]</code> log line.
        </p>
        <div className={styles.list}>
          {effects.map((name) => {
            const detail = EFFECT_DETAIL[name] || { label: name, desc: '' };
            const active = flags.sticker_effect === name;
            return (
              <button
                key={name}
                type="button"
                className={`${styles.profileRow} ${active ? styles.profileActive : ''}`}
                onClick={() => selectEffect(name)}
                disabled={saving}
              >
                <span className={styles.radioDot}>
                  <span className={`${styles.radioDotInner} ${active ? styles.radioDotOn : ''}`} />
                </span>
                <div className={styles.rowText}>
                  <span className={styles.rowLabel}>{detail.label}</span>
                  <span className={styles.rowHint}>{detail.desc}</span>
                </div>
              </button>
            );
          })}
        </div>

        {/* Stroke Color Picker — visible only when stroke effect is active */}
        {flags.sticker_effect === 'stroke' && (
          <div className={styles.colorPickerRow}>
            <label className={styles.colorPickerLabel}>Stroke Color</label>
            <div className={styles.colorPickerControls}>
              <input
                type="color"
                value={draftColor ?? flags.sticker_stroke_color ?? '#FFFFFF'}
                onChange={(e) => setDraftColor(e.target.value)}
                className={styles.colorInput}
                disabled={saving}
              />
              <input
                type="text"
                value={draftColor ?? flags.sticker_stroke_color ?? '#FFFFFF'}
                onChange={(e) => {
                  const v = e.target.value.trim();
                  if (/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6})$/.test(v)) {
                    setDraftColor(v);
                  }
                }}
                className={styles.colorHexInput}
                placeholder="#FFFFFF"
                maxLength={7}
                disabled={saving}
              />
              <span
                className={styles.colorPreview}
                style={{ background: draftColor ?? flags.sticker_stroke_color ?? '#FFFFFF' }}
              />
            </div>

            {/* Stroke Thickness */}
            <label className={styles.colorPickerLabel} style={{ marginTop: '0.75rem' }}>Stroke Thickness — {draftWidth ?? savedWidth}px</label>
            <div className={styles.colorPickerControls}>
              <input
                type="range"
                min={1}
                max={20}
                step={1}
                value={draftWidth ?? savedWidth}
                onChange={(e) => setDraftWidth(parseInt(e.target.value, 10))}
                className={styles.thicknessSlider}
                disabled={saving}
              />
              <input
                type="number"
                min={1}
                max={20}
                value={draftWidth ?? savedWidth}
                onChange={(e) => {
                  const v = parseInt(e.target.value, 10);
                  if (!isNaN(v) && v >= 1 && v <= 20) setDraftWidth(v);
                }}
                className={styles.thicknessNumber}
                disabled={saving}
              />
            </div>

            {/* Save / Cancel buttons for color + thickness */}
            <div className={styles.colorActions}>
              <button
                type="button"
                className={styles.colorSaveBtn}
                onClick={saveStrokeSettings}
                disabled={saving || !strokeIsDirty}
              >
                Save
              </button>
              <button
                type="button"
                className={styles.colorCancelBtn}
                onClick={cancelStrokeSettings}
                disabled={saving || !strokeIsDirty}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
