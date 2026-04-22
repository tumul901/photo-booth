import { useState, useCallback } from "react";

export function useWordSelection(maxSelections: number, slotCount: number) {
  const [selected, setSelected] = useState<string[]>([]);

  // effectiveMax: user can't select more words than there are slots
  const effectiveMax = Math.min(maxSelections, slotCount);

  const toggle = useCallback(
    (wordId: string) => {
      setSelected((prev) => {
        if (prev.includes(wordId)) {
          return prev.filter((id) => id !== wordId); // always allow deselect
        }
        if (prev.length >= effectiveMax) {
          return prev; // at cap — do nothing
        }
        return [...prev, wordId];
      });
    },
    [effectiveMax],
  );

  const selectBundle = useCallback(
    (bundleWords: string[]) => {
      setSelected(bundleWords.slice(0, effectiveMax)); // truncate to effectiveMax
    },
    [effectiveMax],
  );

  const clearAll = useCallback(() => setSelected([]), []);

  return { selected, toggle, selectBundle, clearAll, effectiveMax };
}
