'use client';

interface SelectionCounterProps {
  selected: number;
  max: number;
}

export default function SelectionCounter({ selected, max }: SelectionCounterProps) {
  const isFull = selected === max;
  const isEmpty = selected === 0;

  return (
    <div
      aria-live="polite"
      className={`selectionCounter ${isFull ? 'full' : isEmpty ? 'empty' : ''}`}
      style={{
        textAlign: 'center',
        fontWeight: 600,
        fontSize: '1rem',
        padding: '0.5rem 1rem',
        borderRadius: '999px',
        display: 'inline-block',
        color: isFull ? '#2E5A2D' : isEmpty ? '#8fa88d' : '#2E5A2D',
        background: isFull ? '#dcfce7' : isEmpty ? '#f3f4f6' : '#e5e7eb',
        transition: 'all 0.2s ease',
      }}
    >
      {selected} / {max} selected
    </div>
  );
}
