'use client';

/**
 * TemplateSelector Component
 * ==========================
 * Displays available templates with visual previews.
 * Filters by processing mode (frame/sticker).
 */

import { useState, useEffect, useMemo } from 'react';
import styles from './TemplateSelector.module.css';

interface Template {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker';
  slotCount: number;
  anchorMode: string;
}

interface TemplateSelectorProps {
  selectedTemplate: string;
  onSelect: (templateId: string) => void;
  processingMode?: 'frame' | 'sticker';
}

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function TemplateSelector({
  selectedTemplate,
  onSelect,
  processingMode = 'frame',
}: TemplateSelectorProps) {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const fetchTemplates = async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/templates`);
        const data = await response.json();
        setTemplates(data.templates || []);
      } catch (error) {
        console.error('Failed to fetch templates:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTemplates();
  }, []);

  // Filter templates based on processing mode
  const filteredTemplates = useMemo(() => {
    return templates.filter(t => t.templateType === processingMode);
  }, [templates, processingMode]);

  if (loading) {
    return (
      <div className={styles.container}>
        <p className={styles.loading}>Loading frames...</p>
      </div>
    );
  }

  if (filteredTemplates.length === 0) {
    return (
      <div className={styles.container}>
        <p className={styles.empty}>
          {loading ? 'Loading...' : `No ${processingMode === 'frame' ? 'frames' : 'sticker templates'} available`}
        </p>
      </div>
    );
  }

  return (
    <div className={styles.container}>
      <div className={styles.templateGrid}>
        {filteredTemplates.map((template) => (
          <button
            key={template.templateId}
            className={`${styles.templateCard} ${
              selectedTemplate === template.templateId ? styles.selected : ''
            }`}
            onClick={() => onSelect(template.templateId)}
          >
            {/* Frame Preview Image */}
            <div className={styles.previewWrapper}>
              <img
                src={`${API_BASE_URL}/api/templates/${template.templateId}/image`}
                alt={template.name}
                className={styles.previewImage}
                onError={(e) => {
                  e.currentTarget.style.display = 'none';
                }}
              />
            </div>
            <span className={styles.templateName}>{template.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
