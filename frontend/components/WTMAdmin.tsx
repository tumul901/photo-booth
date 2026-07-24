"use client";

import React, { useState, useEffect } from 'react';
import styles from './WTMAdmin.module.css';
import { WTMTemplateListItem, WTMTemplateConfig } from '@/types/wtm';
import WTMSlotEditor from './WTMSlotEditor';
import WTMWordManager from './WTMWordManager';

interface WTMAdminProps {
  apiBaseUrl: string;
}

const WTMAdmin: React.FC<WTMAdminProps> = ({ apiBaseUrl }) => {
  const [view, setView] = useState<'list' | 'slot-editor' | 'word-manager'>('list');
  const [templates, setTemplates] = useState<WTMTemplateListItem[]>([]);
  const [selectedConfig, setSelectedConfig] = useState<WTMTemplateConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Create form state
  const [createName, setCreateName] = useState('');
  const [createFile, setCreateFile] = useState<File | null>(null);
  const [isCreating, setIsCreating] = useState(false);

  // Cache clearing
  const [isClearingCache, setIsClearingCache] = useState(false);
  const [cacheMsg, setCacheMsg] = useState<string | null>(null);

  useEffect(() => {
    if (view === 'list') {
      fetchTemplates();
    }
  }, [view]);

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates`);
      if (!res.ok) throw new Error('Failed to load templates');
      const data = await res.json();
      setTemplates(data);
      setError(null);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadConfig = async (templateId: string): Promise<WTMTemplateConfig> => {
    const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${templateId}/config`);
    if (!res.ok) throw new Error('Failed to load template configuration');
    return res.json();
  };

  const handleEditSlots = async (templateId: string) => {
    setLoading(true);
    try {
      const config = await loadConfig(templateId);
      setSelectedConfig(config);
      setView('slot-editor');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleEditWords = async (templateId: string) => {
    setLoading(true);
    try {
      const config = await loadConfig(templateId);
      setSelectedConfig(config);
      setView('word-manager');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async (templateId: string) => {
    if (!confirm('Are you sure you want to delete this Entire Word Template? This cannot be undone.')) return;
    
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates/${templateId}`, {
        method: 'DELETE'
      });
      if (!res.ok) throw new Error('Failed to delete template');
      fetchTemplates();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleClearCache = async () => {
    if (!confirm('Delete all cached WTM composition images? They will be regenerated on next use.')) return;
    setIsClearingCache(true);
    setCacheMsg(null);
    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/cache`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Failed to clear cache');
      const data = await res.json();
      setCacheMsg(`Cleared ${data.deleted_files} files (${data.freed_mb} MB freed)`);
    } catch (err: any) {
      setCacheMsg(`Error: ${err.message}`);
    } finally {
      setIsClearingCache(false);
    }
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!createName || !createFile) return;
    if (createFile.type !== 'image/png') {
      alert('Only PNG files are allowed for the base image.');
      return;
    }

    setIsCreating(true);
    const formData = new FormData();
    formData.append('file', createFile);
    formData.append('name', createName);

    try {
      const res = await fetch(`${apiBaseUrl}/api/admin/wtm/templates`, {
        method: 'POST',
        body: formData
      });
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.detail?.message || 'Failed to create template');
      }
      setCreateName('');
      setCreateFile(null);
      fetchTemplates();
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsCreating(false);
    }
  };

  if (view === 'slot-editor' && selectedConfig) {
    return (
      <div className={styles.editorWrapper}>
        <button className={styles.backButton} onClick={() => setView('list')}>
          ← Back to List
        </button>
        <WTMSlotEditor 
          config={selectedConfig} 
          apiBaseUrl={apiBaseUrl}
          onSaved={() => {}} 
          onBack={() => setView('list')} 
        />
      </div>
    );
  }

  if (view === 'word-manager' && selectedConfig) {
    return (
      <div className={styles.editorWrapper}>
        <button className={styles.backButton} onClick={() => setView('list')}>
          ← Back to List
        </button>
        <WTMWordManager
          config={selectedConfig}
          apiBaseUrl={apiBaseUrl}
          onConfigUpdated={(newConfig: WTMTemplateConfig) => setSelectedConfig(newConfig)}
        />
      </div>
    );
  }


  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <h2 className={styles.title}>Word Templates</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          {cacheMsg && <span style={{ fontSize: '0.85rem', color: '#666' }}>{cacheMsg}</span>}
          <button
            className={styles.actionButton}
            onClick={handleClearCache}
            disabled={isClearingCache}
          >
            {isClearingCache ? 'Clearing...' : '🗑️ Clear Cache'}
          </button>
        </div>
      </div>

      {error && <div className={styles.error}>{error}</div>}

      <div className={styles.grid}>
        {/* Create Card */}
        <div className={`${styles.card} ${styles.createCard}`}>
          <h3>Create New Template</h3>
          <form className={styles.form} onSubmit={handleCreate}>
            <input 
              className={styles.input}
              type="text" 
              placeholder="Template Name (e.g. Summer Party)"
              value={createName}
              onChange={(e) => setCreateName(e.target.value)}
              required
            />
            <label className={styles.fileLabel}>
              <span>{createFile ? `📄 ${createFile.name}` : '📤 Upload Base PNG'}</span>
              <input 
                type="file" 
                accept="image/png" 
                onChange={(e) => setCreateFile(e.target.files?.[0] || null)}
                hidden
              />
            </label>
            <button 
              className={styles.submitButton} 
              type="submit" 
              disabled={isCreating || !createName || !createFile}
            >
              {isCreating ? 'Creating...' : 'Create Template'}
            </button>
          </form>
        </div>

        {/* List of Templates */}
        {loading && <div className={styles.loading}>Loading templates...</div>}
        
        {!loading && templates.map(t => (
          <div key={t.template_id} className={styles.card}>
            <div className={styles.previewArea}>
              <img 
                className={styles.previewImage}
                src={`${apiBaseUrl}/api/admin/wtm/templates/${t.template_id}/image`}
                alt={t.name}
              />
            </div>
            <div className={styles.cardContent}>
              <div className={styles.templateName}>{t.name}</div>
              <div className={styles.stats}>
                <span className={styles.statItem}>📏 {t.slot_count} Slots</span>
                <span className={styles.statItem}>🔤 {t.word_count} Words</span>
              </div>
              <div className={styles.actions}>
                <button className={styles.actionButton} onClick={() => handleEditSlots(t.template_id)}>
                  ✏️ Edit Slots
                </button>
                <button className={styles.actionButton} onClick={() => handleEditWords(t.template_id)}>
                  🔤 Edit Words
                </button>
                <button className={`${styles.actionButton} ${styles.deleteButton}`} onClick={() => handleDelete(t.template_id)}>
                  🗑️ Delete
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default WTMAdmin;
