'use client';

/**
 * TemplateSelector Component
 * ==========================
 * Displays available templates with visual previews.
 * Filters by processing mode (frame/sticker).
 */

import { useState, useEffect, useMemo } from 'react';
import styles from './TemplateSelector.module.css';

import type { WTMTemplateListItem } from '@/types/wtm';

interface Template {
  templateId: string;
  name: string;
  templateType: 'frame' | 'sticker' | 'word_template' | 'magazine';
  compositeMode: string;
  slotCount: number;
  anchorMode: string;
}

interface TemplateSelectorProps {
  selectedTemplate: string;
  onSelect: (templateId: string, compositeMode: string) => void;
  processingMode?: 'frame' | 'sticker' | 'word_template' | 'magazine';
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
        if (processingMode === 'word_template') {
          const response = await fetch(`${API_BASE_URL}/api/admin/wtm/templates`);
          const data: WTMTemplateListItem[] = await response.json();
          setTemplates(
            data.map((t) => ({
              templateId: t.template_id,
              name: t.name,
              templateType: 'word_template' as const,
              compositeMode: 'none',
              slotCount: t.slot_count,
              anchorMode: 'none',
            })),
          );
        } else {
          const response = await fetch(`${API_BASE_URL}/api/templates`);
          const data = await response.json();
          setTemplates(data.templates || []);
        }
      } catch (error) {
        console.error('Failed to fetch templates:', error);
      } finally {
        setLoading(false);
      }
    };

    fetchTemplates();
  }, [processingMode]);

  const filteredTemplates = useMemo(() => {
    if (processingMode === 'magazine') {
      return templates.filter(t => t.templateType === 'magazine');
    }
    // Sticker mode shows only regular sticker templates (magazine has its own mode now)
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
          {loading ? 'Loading...' : `No ${processingMode === 'frame' ? 'frames' : processingMode === 'sticker' ? 'sticker templates' : 'word templates'} available`}
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
            onClick={() => onSelect(template.templateId, template.compositeMode)}
          >
            {/* Frame Preview Image */}
            <div className={styles.previewWrapper}>
              <img
                src={
                  template.templateType === 'word_template'
                    ? `${API_BASE_URL}/api/admin/wtm/templates/${template.templateId}/image`
                    : `${API_BASE_URL}/api/templates/${template.templateId}/image`
                }
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
