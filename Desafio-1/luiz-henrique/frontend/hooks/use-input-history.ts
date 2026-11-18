'use client';

import { useCallback, useState } from 'react';

export function useInputHistory(userTexts: string[]) {
  const [input, setInput] = useState('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);

  const resetIndex = useCallback(() => setHistoryIndex(null), []);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (userTexts.length === 0) return;
        const nextIndex =
          historyIndex === null ? userTexts.length - 1 : Math.max(0, historyIndex - 1);
        setHistoryIndex(nextIndex);
        setInput(userTexts[nextIndex]);
      } else if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (userTexts.length === 0 || historyIndex === null) return;
        const nextIndex = historyIndex + 1;
        if (nextIndex >= userTexts.length) {
          setHistoryIndex(null);
          setInput('');
        } else {
          setHistoryIndex(nextIndex);
          setInput(userTexts[nextIndex]);
        }
      } else {
        setHistoryIndex(null);
      }
    },
    [historyIndex, userTexts],
  );

  return { input, setInput, handleKeyDown, resetIndex };
}
