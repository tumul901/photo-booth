'use client';

/**
 * StepIndicator Component
 * =======================
 * Horizontal progress bar for the 4-step wizard.
 * Shows step number, label, and completion state.
 */

import styles from './StepIndicator.module.css';
import type { ProcessingMode } from '@/types/processingMode';

// Inline SVGs rather than an icon library — a handful of glyphs are needed,
// so a dependency would outweigh what it buys. `currentColor` picks up the
// step circle's existing text color, so no separate color prop to thread through.
function ModeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2.3A4.2 4.2 0 0 0 21 10c0-3.9-4-7-9-7z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="7.2" r="1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="7.2" r="1" fill="currentColor" stroke="none" />
    </svg>
  );
}

function TemplateIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function WordsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function CaptureIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 8a2 2 0 0 1 2-2h1.5l1-1.5h7l1 1.5H18a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8z" />
      <circle cx="12" cy="13" r="3.5" />
    </svg>
  );
}

function DetailsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

function ResultIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="12 2 15 9 22 9.5 16.5 14 18.5 21 12 17 5.5 21 7.5 14 2 9.5 9 9" />
    </svg>
  );
}

const STEPS_DEFAULT = [
  { label: 'Mode', icon: <ModeIcon /> },
  { label: 'Template', icon: <TemplateIcon /> },
  { label: 'Capture', icon: <CaptureIcon /> },
  { label: 'Result', icon: <ResultIcon /> },
];

const STEPS_WTM = [
  { label: 'Mode', icon: <ModeIcon /> },
  { label: 'Template', icon: <TemplateIcon /> },
  { label: 'Words', icon: <WordsIcon /> },
  { label: 'Capture', icon: <CaptureIcon /> },
  { label: 'Result', icon: <ResultIcon /> },
];

const STEPS_MAGAZINE = [
  { label: 'Mode', icon: <ModeIcon /> },
  { label: 'Template', icon: <TemplateIcon /> },
  { label: 'Details', icon: <DetailsIcon /> },
  { label: 'Capture', icon: <CaptureIcon /> },
  { label: 'Result', icon: <ResultIcon /> },
];

interface StepIndicatorProps {
  currentStep: number; // 1-based
  processingMode?: ProcessingMode;
}

export default function StepIndicator({ currentStep, processingMode }: StepIndicatorProps) {
  let STEPS = STEPS_DEFAULT;
  if (processingMode === 'word_template') STEPS = STEPS_WTM;
  if (processingMode === 'magazine') STEPS = STEPS_MAGAZINE;

  return (
    <div className={styles.container}>
      {STEPS.map((step, index) => {
        const stepNum = index + 1;
        const isActive = stepNum === currentStep;
        const isCompleted = stepNum < currentStep;

        return (
          <div key={stepNum} className={styles.stepWrapper}>
            {/* Connector line (before each step except first) */}
            {index > 0 && (
              <div
                className={`${styles.connector} ${isCompleted || isActive ? styles.connectorActive : ''}`}
              />
            )}

            <div
              className={`${styles.step} ${isActive ? styles.active : ''} ${isCompleted ? styles.completed : ''}`}
            >
              <div className={styles.circle}>
                {isCompleted ? '✓' : step.icon}
              </div>
              <span className={styles.label}>{step.label}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
