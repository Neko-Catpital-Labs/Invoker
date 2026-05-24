/**
 * Keyboard navigation primitives shared between context menus.
 *
 * Both ContextMenu and WorkflowContextMenu need: auto-focus the menu on mount,
 * cycle through enabled items with ArrowUp/ArrowDown, activate with Enter or
 * Space, and own those keys (preventDefault + stopPropagation) so App-level
 * graph shortcuts don't fire concurrently.
 */

import { useEffect, useState, type KeyboardEvent, type RefObject } from 'react';

export interface MenuKeyboardItem {
  enabled: boolean;
}

export interface UseMenuKeyboardResult {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  handleKeyDown: (event: KeyboardEvent) => void;
}

export function useMenuKeyboard<T extends MenuKeyboardItem>(
  menuRef: RefObject<HTMLElement | null>,
  items: T[],
  onActivate: (item: T, index: number) => void,
): UseMenuKeyboardResult {
  const [focusedIndex, setFocusedIndex] = useState(() => {
    const idx = items.findIndex((item) => item.enabled);
    return idx >= 0 ? idx : 0;
  });

  // preventScroll avoids the page jumping when the menu opens off-screen
  // before viewport clamping repositions it.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleKeyDown = (event: KeyboardEvent) => {
    const enabledIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].enabled) enabledIndices.push(i);
    }
    if (enabledIndices.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const pos = enabledIndices.indexOf(focusedIndex);
      const nextPos = pos === -1 ? 0 : (pos + 1) % enabledIndices.length;
      setFocusedIndex(enabledIndices[nextPos]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const pos = enabledIndices.indexOf(focusedIndex);
      const prevPos =
        pos === -1
          ? enabledIndices.length - 1
          : (pos - 1 + enabledIndices.length) % enabledIndices.length;
      setFocusedIndex(enabledIndices[prevPos]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const current = items[focusedIndex];
      if (current?.enabled) {
        onActivate(current, focusedIndex);
      }
    }
  };

  return { focusedIndex, setFocusedIndex, handleKeyDown };
}
