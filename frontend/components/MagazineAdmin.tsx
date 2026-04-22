'use client';

/**
 * MagazineAdmin Component
 * =======================
 * Admin panel for managing Magazine Photobooth templates.
 *
 * A magazine template has three layers:
 *   1. BG image  — uploaded at creation (the scene/backdrop)
 *   2. User cutout — placed via slot + face anchor
 *   3. FG image  — uploaded here (magazine title, text, borders)
 *
 * Flow:
 *   1. Create: enter name → upload BG → template created
 *   2. Upload FG: pick foreground overlay PNG → upload
 *   3. Configure: opens TemplateEditor to draw the person slot + set face anchor
 */

import { useState, useEffect, useRef } from 'react';
import styles from './MagazineAdmin.module.css';
import TemplateEditor from './TemplateEditor';

interface MagazineTemplate {
  id: string;
  name: string;
  png_path: string;    // BG filename
  fg_path: string;     // FG filename (may be empty)
}

interface MagazineAdminProps {
  apiBaseUrl: string;
}

type TemplateConfig = Parameters<React.ComponentProps<typeof TemplateEditor>['onSave']>[0];

export default function MagazineAdmin({ apiBaseUrl }: MagazineAdminProps) {
  const [templates, setTemplates] = useState<MagazineTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [editingTemplate, setEditingTemplate] = useState<MagazineTemplate | null>(null);

  // Create form state
  const [createName, setCreateName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const bgFileRef = useRef<HTMLInputElement>(null);

  // Per-card FG upload state: { [templateId]: File | null }
  const [fgFiles, setFgFiles] = useState<Record<string, File | null>>({});
  const [uploadingFg, setUploadingFg] = useState<Record<string, boolean>>({});

  useEffect(() => {
    fetchTemplates();
  }, []);

  async function fetchTemplates() {
    setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/templates`);
      const data: Array<{ id: string; name: string; mode: string; png_path: string }> = await res.json();
      const magazine = data.filter(t => t.mode === 'magazine');

      // Fetch full config for each to get fg_path
      const full = await Promise.all(
        magazine.map(async t => {
          try {
            const cr = await fetch(`${apiBaseUrl}/api/admin/templates/${t.id}/config`);
            const cfg = await cr.json();
            return { id: t.id, name: t.name, png_path: t.png_path, fg_path: cfg.fg_path || '' };
          } catch {
            return { id: t.id, name: t.name, png_path: t.png_path, fg_path: '' };
          }
        })
      );
      setTemplates(full);
    } catch (err) {
      console.error('Failed to fetch magazine templates:', err);
    } finally {
      setLoading(false);
    }
  }

  // --- Create magazine template (BG upload) ---
  async function handleCreate() {
    const file = bgFileRef.current?.files?.[0];
    if (!createName.trim() || !file) {
      alert('Enter a name and select the Background image.');
      return;
    }

    setIsCreating(true);
    const form = new FormData();
    form.append('file', file);
    form.append('mode', 'magazine');
    form.append('name', createName.trim());

    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/templates`, { method: 'POST', body: form });
      if (!res.ok) throw new Error((await res.json()).detail || 'Create failed');
      setCreateName('');
      if (bgFileRef.current) bgFileRef.current.value = '';
      await fetchTemplates();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsCreating(false);
    }
  }

  // --- Upload FG overlay ---
  async function handleFgUpload(templateId: string) {
    const file = fgFiles[templateId];
    if (!file) return;

    setUploadingFg(prev => ({ ...prev, [templateId]: true }));
    const form = new FormData();
    form.append('file', file);

    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/templates/${templateId}/fg`, {
        method: 'POST',
        body: form,
      });
      if (!res.ok) throw new Error((await res.json()).detail || 'Upload failed');
      setFgFiles(prev => ({ ...prev, [templateId]: null }));
      await fetchTemplates();
    } catch (err: any) {
      alert(`FG upload error: ${err.message}`);
    } finally {
      setUploadingFg(prev => ({ ...prev, [templateId]: false }));
    }
  }

  // --- Delete template ---
  async function handleDelete(id: string) {
    if (!confirm('Delete this magazine template?')) return;
    await fetch(`${apiBaseUrl}/api/admin/templates/${id}`, { method: 'DELETE' });
    await fetchTemplates();
  }

  // --- Save config from TemplateEditor ---
  async function handleSaveConfig(config: TemplateConfig) {
    const res = await fetch(`${apiBaseUrl}/api/admin/templates/${config.templateId}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Save failed');
    }
    alert('Magazine template saved!');
    setEditingTemplate(null);
    fetchTemplates();
  }

  // --- Render TemplateEditor when configuring ---
  if (editingTemplate) {
    return (
      <TemplateEditor
        templateId={editingTemplate.id}
        templateName={editingTemplate.name}
        imageUrl={`${apiBaseUrl}/api/admin/templates/${editingTemplate.id}/image`}
        onSave={handleSaveConfig}
        onCancel={() => setEditingTemplate(null)}
      />
    );
  }

  return (
    <div className={styles.container}>
      <h2 className={styles.sectionTitle}>Magazine Templates</h2>
      <p className={styles.subtitle}>
        Each magazine cover is a 3-layer sandwich: <strong>Background → User cutout → Foreground overlay</strong>.
        Upload both PNGs from your designer, then draw the person slot.
      </p>

      {/* Create new template */}
      <div className={styles.createCard}>
        <h3 className={styles.createTitle}>+ New Magazine Template</h3>
        <div className={styles.createRow}>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Template Name</label>
            <input
              className={styles.input}
              type="text"
              placeholder="e.g. CEO Cover, Wedding Edition"
              value={createName}
              onChange={e => setCreateName(e.target.value)}
            />
          </div>
          <div className={styles.fieldGroup}>
            <label className={styles.fieldLabel}>Background Image (BG layer)</label>
            <input
              className={styles.fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              ref={bgFileRef}
            />
          </div>
          <button
            className={styles.createButton}
            onClick={handleCreate}
            disabled={isCreating || !createName.trim()}
          >
            {isCreating ? 'Creating…' : 'Create Template'}
          </button>
        </div>
      </div>

      {/* Template list */}
      {loading ? (
        <div className={styles.loading}>Loading…</div>
      ) : templates.length === 0 ? (
        <div className={styles.empty}>No magazine templates yet. Create one above.</div>
      ) : (
        <div className={styles.grid}>
          {templates.map(t => (
            <div key={t.id} className={styles.card}>
              {/* BG preview */}
              <div className={styles.previewStack}>
                <img
                  src={`${apiBaseUrl}/api/admin/templates/${t.id}/image`}
                  alt={`${t.name} background`}
                  className={styles.previewBg}
                />
                {t.fg_path && (
                  <img
                    src={`${apiBaseUrl}/api/admin/templates/${t.id}/fg-image?t=${Date.now()}`}
                    alt={`${t.name} foreground`}
                    className={styles.previewFg}
                  />
                )}
                <div className={styles.layerBadge}>
                  {t.fg_path
                    ? '✅ BG + FG ready'
                    : '⚠️ FG missing'}
                </div>
              </div>

              <div className={styles.cardBody}>
                <div className={styles.templateName}>{t.name}</div>
                <div className={styles.templateId}>{t.id}</div>

                {/* FG upload */}
                <div className={styles.fgSection}>
                  <label className={styles.fgLabel}>
                    {t.fg_path ? '🔄 Replace Foreground (FG)' : '📤 Upload Foreground (FG)'}
                  </label>
                  <div className={styles.fgRow}>
                    <input
                      className={styles.fileInputSm}
                      type="file"
                      accept="image/png"
                      onChange={e => setFgFiles(prev => ({ ...prev, [t.id]: e.target.files?.[0] ?? null }))}
                    />
                    <button
                      className={styles.uploadFgButton}
                      disabled={!fgFiles[t.id] || uploadingFg[t.id]}
                      onClick={() => handleFgUpload(t.id)}
                    >
                      {uploadingFg[t.id] ? 'Uploading…' : 'Upload'}
                    </button>
                  </div>
                  {t.fg_path && (
                    <span className={styles.fgFilename}>{t.fg_path}</span>
                  )}
                </div>

                {/* Actions */}
                <div className={styles.actions}>
                  <button
                    className={styles.configureButton}
                    onClick={() => setEditingTemplate(t)}
                  >
                    ⚙️ Configure Slot
                  </button>
                  <button
                    className={styles.deleteButton}
                    onClick={() => handleDelete(t.id)}
                  >
                    🗑️
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
