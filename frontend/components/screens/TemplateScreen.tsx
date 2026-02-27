'use client';

/**
 * TemplateScreen Component (Step 2)
 * ==================================
 * Frame/template selection screen with scrollable grid.
 * Filters templates by the selected processing mode.
 */

import TemplateSelector from '../TemplateSelector';
import styles from './TemplateScreen.module.css';

interface TemplateScreenProps {
  selectedTemplate: string;
  processingMode: 'frame' | 'sticker';
  onSelect: (id: string) => void;
  onNext: () => void;
  onBack: () => void;
}

export default function TemplateScreen({
  selectedTemplate,
  processingMode,
  onSelect,
  onNext,
  onBack,
}: TemplateScreenProps) {
  return (
    <div className={styles.container}>
      <header className={styles.header}>
        <button className={styles.backButton} onClick={onBack}>← Back</button>
        <h2 className={styles.title}>Choose Your Template</h2>
        <div className={styles.placeholder} />
      </header>

      <div className={styles.scrollArea}>
        <TemplateSelector
          selectedTemplate={selectedTemplate}
          onSelect={onSelect}
          processingMode={processingMode}
        />
      </div>

      <footer className={styles.footer}>
        <button
          className={styles.nextButton}
          onClick={onNext}
          disabled={!selectedTemplate}
        >
          Next Step →
        </button>
      </footer>
    </div>
  );
}
