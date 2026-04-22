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
  onSelectMode: (mode: 'frame' | 'sticker' | 'word_template' | 'magazine') => void;
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

          <button
            className={styles.modeCard}
            onClick={() => onSelectMode('word_template')}
          >
            <span className={styles.modeIcon}>🔤</span>
            <span className={styles.modeTitle}>Word Template</span>
            <span className={styles.modeDesc}>
              Choose words that appear on your doodle template
            </span>
          </button>

          <button
            className={styles.modeCard}
            onClick={() => onSelectMode('magazine')}
          >
            <span className={styles.modeIcon}>📰</span>
            <span className={styles.modeTitle}>Magazine Cover</span>
            <span className={styles.modeDesc}>
              Become the cover star of your own magazine
            </span>
          </button>
        </div>
      </div>
      <div className={styles.bgGlow} />
    </div>
  );
}
