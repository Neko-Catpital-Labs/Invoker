import { useState, useEffect, type RefObject, type KeyboardEvent as ReactKeyboardEvent } from 'react';

export function useMenuKeyboard(
  itemCount: number,
  isItemEnabled: (index: number) => boolean,
  onActivate: (index: number) => void,
  menuRef: RefObject<HTMLDivElement | null>,
) {
  const [focusedIndex, setFocusedIndex] = useState(() => {
    for (let i = 0; i < itemCount; i++) {
      if (isItemEnabled(i)) return i;
    }
    return 0;
  });

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, [menuRef]);

  const handleKeyDown = (e: ReactKeyboardEvent) => {
    const enabled: number[] = [];
    for (let i = 0; i < itemCount; i++) {
      if (isItemEnabled(i)) enabled.push(i);
    }
    if (enabled.length === 0) return;

    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      const pos = enabled.indexOf(focusedIndex);
      const delta = e.key === 'ArrowDown' ? 1 : -1;
      const next = (pos + delta + enabled.length) % enabled.length;
      setFocusedIndex(enabled[next]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      if (enabled.includes(focusedIndex)) {
        onActivate(focusedIndex);
      }
    }
  };

  return { focusedIndex, setFocusedIndex, handleKeyDown };
}
