/**
 * Shared keyboard wiring for context menus.
 *
 * - Focuses the menu container on mount (preventScroll) so onKeyDown receives keys
 *   without scrolling the viewport.
 * - Tracks a focused item index, defaulting to the first enabled item.
 * - Provides an onKeyDown handler that cycles ArrowUp/ArrowDown across enabled
 *   items (skipping disabled) and activates the highlighted item on Enter/Space.
 * - For every key it handles, it calls preventDefault and stopPropagation so the
 *   App-level document keydown listener cannot also consume the key.
 */

import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';

export interface MenuKeyboardItem {
  readonly enabled: boolean;
}

export interface UseMenuKeyboardOptions<T extends MenuKeyboardItem> {
  menuRef: RefObject<HTMLElement | null>;
  items: ReadonlyArray<T>;
  onActivate: (index: number) => void;
}

export interface UseMenuKeyboardResult {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
}

function firstEnabledIndex(items: ReadonlyArray<MenuKeyboardItem>): number {
  return items.findIndex((item) => item.enabled);
}

export function useMenuKeyboard<T extends MenuKeyboardItem>(
  options: UseMenuKeyboardOptions<T>,
): UseMenuKeyboardResult {
  const { menuRef, items, onActivate } = options;
  const [focusedIndex, setFocusedIndex] = useState(() => firstEnabledIndex(items));

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    // Focus only on first mount; subsequent renders (e.g. More expansion) keep
    // focus on the still-mounted menu element.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const enabledIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) enabledIndices.push(i);
  }

  const handleKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      if (enabledIndices.length === 0) return;
      const currentPos = enabledIndices.indexOf(focusedIndex);
      const nextPos = currentPos < 0 ? 0 : (currentPos + 1) % enabledIndices.length;
      setFocusedIndex(enabledIndices[nextPos]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      if (enabledIndices.length === 0) return;
      const currentPos = enabledIndices.indexOf(focusedIndex);
      const prevPos =
        currentPos < 0
          ? enabledIndices.length - 1
          : (currentPos - 1 + enabledIndices.length) % enabledIndices.length;
      setFocusedIndex(enabledIndices[prevPos]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const item = items[focusedIndex];
      if (item?.enabled) onActivate(focusedIndex);
    }
  };

  return { focusedIndex, setFocusedIndex, handleKeyDown };
}
