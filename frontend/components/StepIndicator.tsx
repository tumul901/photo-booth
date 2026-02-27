'use client';

/**
 * StepIndicator Component
 * =======================
 * Horizontal progress bar for the 4-step wizard.
 * Shows step number, label, and completion state.
 */

import styles from './StepIndicator.module.css';

const STEPS = [
  { label: 'Mode', icon: '🎨' },
  { label: 'Template', icon: '🖼️' },
  { label: 'Capture', icon: '📷' },
  { label: 'Result', icon: '✨' },
];

interface StepIndicatorProps {
  currentStep: number; // 1-based
}

export default function StepIndicator({ currentStep }: StepIndicatorProps) {
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
