'use client';

/**
 * MagazineNameScreen
 * ==================
 * Collects the person's Name and Designation before the photo capture step.
 * Only rendered when the selected template has compositeMode === "magazine".
 *
 * Props:
 *   onConfirm(name, designation) — called when the user clicks Next
 *   onBack()                     — called when the user clicks Back
 *   initialName                  — pre-fills the name field (from sessionStorage)
 *   initialDesignation           — pre-fills the designation field
 */

import { useState, useCallback } from 'react';
import styles from './MagazineNameScreen.module.css';

interface MagazineNameScreenProps {
  onConfirm: (name: string, designation: string) => void;
  onBack: () => void;
  initialName?: string;
  initialDesignation?: string;
}

export default function MagazineNameScreen({
  onConfirm,
  onBack,
  initialName = '',
  initialDesignation = '',
}: MagazineNameScreenProps) {
  const [name, setName] = useState(initialName);
  const [designation, setDesignation] = useState(initialDesignation);
  const [errors, setErrors] = useState<{ name?: string; designation?: string }>({});

  const validate = useCallback((): boolean => {
    const newErrors: { name?: string; designation?: string } = {};
    if (!name.trim()) {
      newErrors.name = 'Name is required';
    }
    if (!designation.trim()) {
      newErrors.designation = 'Designation is required';
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }, [name, designation]);

  const handleNext = useCallback(() => {
    if (validate()) {
      onConfirm(name.trim(), designation.trim());
    }
  }, [validate, onConfirm, name, designation]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleNext();
      }
    },
    [handleNext]
  );

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Your Details</h1>
        <p className={styles.subtitle}>
          These will appear on your magazine cover
        </p>

        <div className={styles.form}>
          {/* Name Field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="mag-name" className={styles.label}>
              Full Name
            </label>
            <input
              id="mag-name"
              type="text"
              className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
              placeholder="e.g. Jane Smith"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                if (errors.name) setErrors((prev) => ({ ...prev, name: undefined }));
              }}
              onKeyDown={handleKeyDown}
              autoFocus
              maxLength={60}
            />
            {errors.name && (
              <span className={styles.errorMsg}>{errors.name}</span>
            )}
          </div>

          {/* Designation Field */}
          <div className={styles.fieldGroup}>
            <label htmlFor="mag-designation" className={styles.label}>
              Designation / Role
            </label>
            <input
              id="mag-designation"
              type="text"
              className={`${styles.input} ${errors.designation ? styles.inputError : ''}`}
              placeholder="e.g. Head of Marketing"
              value={designation}
              onChange={(e) => {
                setDesignation(e.target.value);
                if (errors.designation)
                  setErrors((prev) => ({ ...prev, designation: undefined }));
              }}
              onKeyDown={handleKeyDown}
              maxLength={80}
            />
            {errors.designation && (
              <span className={styles.errorMsg}>{errors.designation}</span>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className={styles.actions}>
          <button className={styles.backBtn} onClick={onBack} type="button">
            ←<span className={styles.backText}> Back</span>
          </button>
          <button className={styles.nextBtn} onClick={handleNext} type="button">
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
