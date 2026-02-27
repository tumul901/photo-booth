"use client";

import { useState, useEffect, useRef } from 'react';
import styles from './page.module.css';
import TemplateEditor from '@/components/TemplateEditor';

// Types
interface Stats {
  total_generated: number;
  by_mode: { [key: string]: number };
  by_template: { [key: string]: number };
  last_updated: string;
}

interface Template {
  id: string;
  name: string;
  mode: 'frame' | 'sticker';
  png_path: string;
}

interface TemplateConfig {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker';
  compositeMode: 'background' | 'overlay';
  pngUrl: string;
  anchorMode: 'face_center' | 'eyes' | 'none';
  dimensions: { width: number; height: number };
  slots: Array<{
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
    anchorX: number;
    anchorY: number;
  }>;
  desiredFaceRatio: number;
  minZoom: number;
  maxZoom: number;
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function AdminPage() {
  const [activeTab, setActiveTab] = useState<'stats' | 'templates'>('stats');
  const [stats, setStats] = useState<Stats | null>(null);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  
  // Upload State
  const [uploadMode, setUploadMode] = useState<'frame' | 'sticker'>('frame');
  const [uploadName, setUploadName] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  
  // Editor State
  const [editingTemplate, setEditingTemplate] = useState<Template | null>(null);

  useEffect(() => {
    fetchData();
  }, [activeTab]);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      if (activeTab === 'stats') {
        const res = await fetch(`${API_BASE_URL}/api/admin/stats`);
        if (!res.ok) throw new Error('Failed to fetch stats');
        const data = await res.json();
        setStats(data);
      } else {
        const res = await fetch(`${API_BASE_URL}/api/admin/templates`);
        if (!res.ok) throw new Error('Failed to fetch templates');
        const data = await res.json();
        setTemplates(data);
      }
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !uploadName) {
      alert("Please enter a name and select a file");
      return;
    }

    setIsUploading(true);
    const formData = new FormData();
    formData.append('file', file);
    formData.append('mode', uploadMode);
    formData.append('name', uploadName);

    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/templates`, {
        method: 'POST',
        body: formData,
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Upload failed');
      }

      const result = await res.json();
      
      // Refresh list
      fetchData();
      setUploadName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
      
      // Open editor for the new template
      if (result.template) {
        setEditingTemplate({
          id: result.template.templateId,
          name: result.template.name,
          mode: result.template.templateType,
          png_path: result.template.pngUrl || result.template.png_path,
        });
      }
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    if (!confirm('Are you sure you want to delete this template?')) return;

    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/templates/${id}`, {
        method: 'DELETE',
      });
      
      if (!res.ok) throw new Error('Delete failed');
      
      fetchData(); // Refresh
    } catch (err: any) {
      alert(`Error: ${err.message}`);
    }
  };

  const handleConfigure = (template: Template) => {
    setEditingTemplate(template);
  };

  const handleSaveConfig = async (config: TemplateConfig) => {
    try {
      const res = await fetch(`${API_BASE_URL}/api/admin/templates/${config.templateId}/config`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      
      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.detail || 'Save failed');
      }
      
      alert('Template configuration saved!');
      setEditingTemplate(null);
      fetchData();
    } catch (err: any) {
      alert(`Error saving config: ${err.message}`);
    }
  };

  const handleCancelEdit = () => {
    setEditingTemplate(null);
  };

  // If editing a template, show the editor
  if (editingTemplate) {
    return (
      <TemplateEditor
        templateId={editingTemplate.id}
        templateName={editingTemplate.name}
        imageUrl={`${API_BASE_URL}/api/templates/${editingTemplate.id}/image`}
        onSave={handleSaveConfig}
        onCancel={handleCancelEdit}
      />
    );
  }

  return (
    <main className={styles.main}>
      <header className={styles.header}>
        <h1 className={styles.title}>Photobooth Admin</h1>
        <nav className={styles.nav}>
          <button 
            className={`${styles.navButton} ${activeTab === 'stats' ? styles.active : ''}`}
            onClick={() => setActiveTab('stats')}
          >
            📊 Stats
          </button>
          <button 
            className={`${styles.navButton} ${activeTab === 'templates' ? styles.active : ''}`}
            onClick={() => setActiveTab('templates')}
          >
            🖼️ Templates
          </button>
        </nav>
      </header>

      <div className={styles.content}>
        {loading && <div className={styles.loading}>Loading...</div>}
        {error && <div className={styles.error}>{error}</div>}

        {!loading && !error && activeTab === 'stats' && stats && (
          <div>
            <h2 className={styles.sectionTitle}>Overview</h2>
            <div className={styles.statsGrid}>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>Total Photos</div>
                <div className={styles.statValue}>{stats.total_generated}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>Frames Used</div>
                <div className={styles.statValue}>{stats.by_mode?.frame || 0}</div>
              </div>
              <div className={styles.statCard}>
                <div className={styles.statLabel}>Stickers Used</div>
                <div className={styles.statValue}>{stats.by_mode?.sticker || 0}</div>
              </div>
            </div>
          </div>
        )}

        {!loading && !error && activeTab === 'templates' && (
          <div>
            <h2 className={styles.sectionTitle}>Manage Templates</h2>
            
            {/* Upload Controls */}
            <div className={styles.controls}>
              <div className={styles.inputGroup}>
                <label className={styles.label}>Mode</label>
                <select 
                  className={styles.select}
                  value={uploadMode}
                  onChange={(e) => setUploadMode(e.target.value as 'frame' | 'sticker')}
                >
                  <option value="frame">Frame</option>
                  <option value="sticker">Sticker</option>
                </select>
              </div>
              
              <div className={styles.inputGroup}>
                <label className={styles.label}>Name</label>
                <input 
                  type="text" 
                  className={styles.input}
                  placeholder="e.g. Summer Party"
                  value={uploadName}
                  onChange={(e) => setUploadName(e.target.value)}
                />
              </div>

              <div className={styles.inputGroup}>
                <input 
                  type="file"
                  id="file-upload"
                  className={styles.fileInput}
                  accept="image/*"
                  ref={fileInputRef}
                  onChange={handleUpload}
                  disabled={isUploading}
                />
                <label htmlFor="file-upload" className={`${styles.uploadButton} ${!uploadName ? styles.disabled : ''}`} style={{display:'flex', alignItems:'center', cursor: uploadName ? 'pointer' : 'not-allowed', opacity: uploadName ? 1 : 0.5}}>
                  {isUploading ? 'Uploading...' : '📤 Upload Image'}
                </label>
              </div>
            </div>

            {/* Template Grid */}
            <div className={styles.templateGrid}>
              {templates.map((t) => (
                <div key={t.id} className={styles.templateCard}>
                  <div className={styles.previewWrapper}>
                    <img 
                      src={`${API_BASE_URL}/api/templates/${t.id}/image`} 
                      alt={t.name}
                      className={styles.preview}
                    />
                  </div>
                  <div className={styles.cardFooter}>
                    <div>
                      <div className={styles.templateName}>{t.name}</div>
                      <div style={{fontSize: '0.7em', color: '#a5b4fc', textTransform: 'uppercase'}}>{t.mode}</div>
                    </div>
                    <div className={styles.cardActions}>
                      <button 
                        className={styles.configureButton}
                        onClick={() => handleConfigure(t)}
                        title="Configure Template"
                      >
                        ⚙️
                      </button>
                      <button 
                        className={styles.deleteButton}
                        onClick={() => handleDelete(t.id)}
                        title="Delete Template"
                      >
                        🗑️
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
            {templates.length === 0 && (
              <p style={{textAlign:'center', color:'#666', marginTop:'2rem'}}>No templates found. Upload one to get started!</p>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
