'use client';

/**
 * ModeSelectScreen Component (Step 1)
 * ====================================
 * Mode cards driven by /api/feature-flags. A mode is hidden if its toggle is
 * off in the admin panel. While the flags are loading we render nothing (no
 * flicker) — the request is cheap and usually returns in <100 ms.
 */

import Image from 'next/image';
import { useEffect, useState } from 'react';
import styles from './StartScreen.module.css';
import type { ProcessingMode } from '@/types/processingMode';

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type Mode = ProcessingMode;

interface ModeSelectScreenProps {
  onSelectMode: (mode: Mode) => void;
}

interface FeatureFlags {
  modes: Record<Mode, boolean>;
  rembg_profile: string;
}

const MODE_CARDS: Array<{ key: Mode; icon: string; title: string; desc: string }> = [
  {
    key: 'frame',
    icon: '🖼️',
    title: 'Frame Mode',
    desc: 'Overlay your photo onto a beautiful template frame',
  },
  {
    key: 'sticker',
    icon: '✂️',
    title: 'Remove Background',
    desc: 'Cut out your background and place onto a template',
  },
  {
    key: 'word_template',
    icon: '🔤',
    title: 'Word Template',
    desc: 'Choose words that appear on your doodle template',
  },
  {
    key: 'magazine',
    icon: '📰',
    title: 'Magazine Cover',
    desc: 'Become the cover star of your own magazine',
  },
  {
    key: 'cartoon',
    icon: '🎨',
    title: 'Cartoon Artwork',
    desc: 'Transform into a comic-style illustration',
  },
  {
    key: 'watercolor',
    icon: '🖌️',
    title: 'Watercolor Filter',
    desc: 'Become a hand-drawn illustrated portrait',
  },
];

export default function ModeSelectScreen({ onSelectMode }: ModeSelectScreenProps) {
  const [flags, setFlags] = useState<FeatureFlags | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`${API_BASE_URL}/api/feature-flags`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: FeatureFlags | null) => {
        if (active && data) setFlags(data);
      })
      .catch(() => {
        // On network failure, fail open — show every card rather than locking the booth.
        if (active) {
          setFlags({
            modes: {
              frame: true, sticker: true, word_template: true,
              magazine: true, cartoon: true, watercolor: true,
            },
            rembg_profile: 'isnet_hi',
          });
        }
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleCards = flags
    ? MODE_CARDS.filter((c) => flags.modes[c.key] !== false)
    : [];

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
          {visibleCards.map((card) => (
            <button
              key={card.key}
              className={styles.modeCard}
              onClick={() => onSelectMode(card.key)}
            >
              <span className={styles.modeIcon}>{card.icon}</span>
              <span className={styles.modeTitle}>{card.title}</span>
              <span className={styles.modeDesc}>{card.desc}</span>
            </button>
          ))}
        </div>
      </div>
      <div className={styles.bgGlow} />
    </div>
  );
}
