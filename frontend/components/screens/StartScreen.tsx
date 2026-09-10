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
import type { ReactNode } from 'react';
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

// Inline SVGs rather than an icon library — six glyphs are needed, so a
// dependency would outweigh what it buys. `currentColor` picks up each
// card's existing text color, so no separate color prop to thread through.
function FrameIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <path d="M21 15l-5-5L5 21" />
    </svg>
  );
}

function ScissorsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
  );
}

function TypeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  );
}

function NewspaperIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 4h12v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V4z" />
      <path d="M16 8h4v10a2 2 0 0 1-2 2h-2" />
      <line x1="7" y1="8" x2="13" y2="8" />
      <line x1="7" y1="11.5" x2="13" y2="11.5" />
      <line x1="7" y1="15" x2="11" y2="15" />
    </svg>
  );
}

function PaletteIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 3a9 9 0 1 0 0 18c1.1 0 2-.9 2-2 0-.5-.2-1-.5-1.4-.3-.4-.5-.9-.5-1.4 0-1.1.9-2 2-2h2.3A4.2 4.2 0 0 0 21 10c0-3.9-4-7-9-7z" />
      <circle cx="7.5" cy="10.5" r="1" fill="currentColor" />
      <circle cx="10.5" cy="7.2" r="1" fill="currentColor" />
      <circle cx="14.5" cy="7.2" r="1" fill="currentColor" />
      <circle cx="16.8" cy="10.5" r="1" fill="currentColor" />
    </svg>
  );
}

function PaintbrushIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.06 11.9l8.07-8.06a2.85 2.85 0 1 1 4.03 4.03l-8.06 8.08" />
      <path d="M7.07 14.94c-1.66 0-3 1.35-3 3.02 0 1.33-1.06 1.75-1 2.02.63.24 1.35.02 2 .02 2.2 0 4-1.8 4-4.04a3.01 3.01 0 0 0-3-3.02z" />
    </svg>
  );
}

const MODE_CARDS: Array<{ key: Mode; icon: ReactNode; title: string; desc: string }> = [
  {
    key: 'frame',
    icon: <FrameIcon />,
    title: 'Frame Mode',
    desc: 'Overlay your photo onto a beautiful template frame',
  },
  {
    key: 'sticker',
    icon: <ScissorsIcon />,
    title: 'Remove Background',
    desc: 'Cut out your background and place onto a template',
  },
  {
    key: 'word_template',
    icon: <TypeIcon />,
    title: 'Word Template',
    desc: 'Choose words that appear on your doodle template',
  },
  {
    key: 'magazine',
    icon: <NewspaperIcon />,
    title: 'Magazine Cover',
    desc: 'Become the cover star of your own magazine',
  },
  {
    key: 'cartoon',
    icon: <PaletteIcon />,
    title: 'Cartoon Artwork',
    desc: 'Transform into a comic-style illustration',
  },
  {
    key: 'watercolor',
    icon: <PaintbrushIcon />,
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
            src="/nestle-logo.png"
            alt="Nestlé"
            width={150}
            height={150}
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
