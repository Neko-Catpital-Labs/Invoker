/**
 * Keyboard navigation primitives shared by context menus.
 *
 * Pulls focus onto the menu container on mount (so arrow keys land on the
 * menu, not the page beneath) and exposes a keydown handler that cycles a
 * highlight across enabled entries and activates the highlighted one on
 * Enter or Space. The host component owns the entry list and disabled state.
 */

import { useEffect, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

export interface UseMenuKeyboardOptions {
  itemCount: number;
  isEnabled: (index: number) => boolean;
  onActivate: (index: number) => void;
}

export interface UseMenuKeyboardResult {
  menuRef: RefObject<HTMLDivElement | null>;
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  handleKeyDown: (event: ReactKeyboardEvent) => void;
}

export function isMenuNavKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || key === 'Enter' || key === ' ';
}

export function useMenuKeyboard({
  itemCount,
  isEnabled,
  onActivate,
}: UseMenuKeyboardOptions): UseMenuKeyboardResult {
  const menuRef = useRef<HTMLDivElement>(null);

  const [focusedIndex, setFocusedIndex] = useState(() => {
    for (let i = 0; i < itemCount; i++) {
      if (isEnabled(i)) return i;
    }
    return 0;
  });

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  const handleKeyDown = (event: ReactKeyboardEvent) => {
    if (!isMenuNavKey(event.key)) return;

    const enabled: number[] = [];
    for (let i = 0; i < itemCount; i++) {
      if (isEnabled(i)) enabled.push(i);
    }
    if (enabled.length === 0) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'ArrowDown') {
      const pos = enabled.indexOf(focusedIndex);
      const next = pos < 0 ? 0 : (pos + 1) % enabled.length;
      setFocusedIndex(enabled[next]);
      return;
    }

    if (event.key === 'ArrowUp') {
      const pos = enabled.indexOf(focusedIndex);
      const prev =
        pos < 0 ? enabled.length - 1 : (pos - 1 + enabled.length) % enabled.length;
      setFocusedIndex(enabled[prev]);
      return;
    }

    if (isEnabled(focusedIndex)) {
      onActivate(focusedIndex);
    }
  };

  return { menuRef, focusedIndex, setFocusedIndex, handleKeyDown };
}
