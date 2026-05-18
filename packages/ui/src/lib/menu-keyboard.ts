/**
 * Shared keyboard wiring for popover menus (task and workflow context menus).
 *
 * Focuses the menu container on open so it owns ArrowUp/ArrowDown/Enter/Space
 * even when the App-level document keydown listener is active. Skips disabled
 * items when cycling and stops propagation on handled keys.
 */

import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type RefObject } from 'react';

export interface MenuKeyboardOptions {
  menuRef: RefObject<HTMLElement | null>;
  itemCount: number;
  isItemEnabled: (index: number) => boolean;
  onActivate: (index: number) => void;
  initialFocusedIndex?: number;
}

export interface MenuKeyboardResult {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export function useMenuKeyboard(options: MenuKeyboardOptions): MenuKeyboardResult {
  const { menuRef, itemCount, isItemEnabled, onActivate, initialFocusedIndex = 0 } = options;

  const itemCountRef = useRef(itemCount);
  itemCountRef.current = itemCount;
  const isEnabledRef = useRef(isItemEnabled);
  isEnabledRef.current = isItemEnabled;
  const activateRef = useRef(onActivate);
  activateRef.current = onActivate;

  const [focusedIndex, setFocusedIndex] = useState(initialFocusedIndex);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const enabled: number[] = [];
    for (let i = 0; i < itemCountRef.current; i++) {
      if (isEnabledRef.current(i)) enabled.push(i);
    }
    if (enabled.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const cur = enabled.indexOf(focusedIndex);
      const pos = cur < 0 ? 0 : (cur + 1) % enabled.length;
      setFocusedIndex(enabled[pos]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const cur = enabled.indexOf(focusedIndex);
      const pos = cur < 0 ? enabled.length - 1 : (cur - 1 + enabled.length) % enabled.length;
      setFocusedIndex(enabled[pos]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      if (isEnabledRef.current(focusedIndex)) activateRef.current(focusedIndex);
    }
  }, [focusedIndex]);

  return { focusedIndex, setFocusedIndex, handleKeyDown };
}
