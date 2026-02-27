'use client';

/**
 * ModeSelectScreen Component (Step 1)
 * ====================================
 * Two large cards for selecting the processing mode:
 *   - Frame: Overlay photo onto template
 *   - Remove BG: Remove background, composite onto template
 */

import Image from 'next/image';
import styles from './StartScreen.module.css';

interface ModeSelectScreenProps {
  onSelectMode: (mode: 'frame' | 'sticker') => void;
}

export default function ModeSelectScreen({ onSelectMode }: ModeSelectScreenProps) {
  return (
    <div className={styles.container}>
      <div className={styles.content}>
        <div className={styles.logoWrapper}>
          <Image
            src="/Cloudplay xp white logo.png"
            alt="Cloudplay XP"
            width={240}
            height={80}
            className={styles.logo}
            priority
          />
        </div>
        <h1 className={styles.title}>Photo Booth</h1>
        <p className={styles.subtitle}>Choose your style</p>

        <div className={styles.modeCards}>
          <button
            className={styles.modeCard}
            onClick={() => onSelectMode('frame')}
          >
            <span className={styles.modeIcon}>🖼️</span>
            <span className={styles.modeTitle}>Frame Mode</span>
            <span className={styles.modeDesc}>
              Overlay your photo onto a beautiful template frame
            </span>
          </button>

          <button
            className={styles.modeCard}
            onClick={() => onSelectMode('sticker')}
          >
            <span className={styles.modeIcon}>✂️</span>
            <span className={styles.modeTitle}>Remove Background</span>
            <span className={styles.modeDesc}>
              Cut out your background and place onto a template
            </span>
          </button>
        </div>
      </div>
      <div className={styles.bgGlow} />
    </div>
  );
}
