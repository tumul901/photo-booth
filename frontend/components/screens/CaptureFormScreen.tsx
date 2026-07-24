'use client';

import { useState, useCallback } from 'react';
import styles from './MagazineNameScreen.module.css';

interface CaptureFormScreenProps {
  onConfirm: (name: string, phone: string) => void;
}

export default function CaptureFormScreen({ onConfirm }: CaptureFormScreenProps) {
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [errors, setErrors] = useState<{ name?: string; phone?: string }>({});

  const validate = useCallback((): boolean => {
    const errs: { name?: string; phone?: string } = {};
    if (!name.trim()) errs.name = 'Name is required';
    if (!phone.trim()) errs.phone = 'Phone number is required';
    setErrors(errs);
    return Object.keys(errs).length === 0;
  }, [name, phone]);

  const handleNext = useCallback(() => {
    if (validate()) onConfirm(name.trim(), phone.trim());
  }, [validate, onConfirm, name, phone]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => { if (e.key === 'Enter') handleNext(); },
    [handleNext],
  );

  return (
    <div className={styles.container}>
      <div className={styles.card}>
        <h1 className={styles.title}>Your Details</h1>
        <p className={styles.subtitle}>We&apos;ll use these to match your photo in the gallery</p>

        <div className={styles.form}>
          <div className={styles.fieldGroup}>
            <label htmlFor="cf-name" className={styles.label}>Full Name</label>
            <input
              id="cf-name"
              type="text"
              className={`${styles.input} ${errors.name ? styles.inputError : ''}`}
              placeholder="e.g. Priya Sharma"
              value={name}
              onChange={e => {
                setName(e.target.value);
                if (errors.name) setErrors(prev => ({ ...prev, name: undefined }));
              }}
              onKeyDown={handleKeyDown}
              autoFocus
              maxLength={60}
            />
            {errors.name && <span className={styles.errorMsg}>{errors.name}</span>}
          </div>

          <div className={styles.fieldGroup}>
            <label htmlFor="cf-phone" className={styles.label}>Phone Number</label>
            <input
              id="cf-phone"
              type="tel"
              inputMode="numeric"
              className={`${styles.input} ${errors.phone ? styles.inputError : ''}`}
              placeholder="e.g. 9876543210"
              value={phone}
              onChange={e => {
                setPhone(e.target.value);
                if (errors.phone) setErrors(prev => ({ ...prev, phone: undefined }));
              }}
              onKeyDown={handleKeyDown}
              maxLength={15}
            />
            {errors.phone && <span className={styles.errorMsg}>{errors.phone}</span>}
          </div>
        </div>

        <div className={styles.actions}>
          <button className={styles.nextBtn} onClick={handleNext} type="button" style={{ flex: 1 }}>
            Continue
          </button>
        </div>
      </div>
    </div>
  );
}
