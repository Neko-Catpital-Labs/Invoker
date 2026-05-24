/**
 * Shared keyboard helpers for popup context menus.
 *
 * Used by ContextMenu (task) and WorkflowContextMenu so arrow/enter/space
 * navigation is consistent: cycle through enabled items, skip disabled, and
 * call preventDefault + stopPropagation so the App-level document keydown
 * handler does not also act on the same keystroke.
 */

import type { KeyboardEvent as ReactKeyboardEvent } from 'react';

export interface KeyboardMenuItem {
  enabled: boolean;
}

/** Keys an open menu owns; the App-level keydown handler should ignore them. */
export function isMenuOwnedKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === ' ';
}

export interface BuildMenuKeyHandlerArgs<T extends KeyboardMenuItem> {
  items: T[];
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  onActivate: (item: T, index: number) => void;
}

export function buildMenuKeyHandler<T extends KeyboardMenuItem>(
  args: BuildMenuKeyHandlerArgs<T>,
): (event: ReactKeyboardEvent) => void {
  const { items, focusedIndex, setFocusedIndex, onActivate } = args;
  return (event) => {
    const enabledIndices: number[] = [];
    for (let i = 0; i < items.length; i++) {
      if (items[i].enabled) enabledIndices.push(i);
    }
    if (enabledIndices.length === 0) return;

    if (event.key === 'ArrowDown') {
      event.preventDefault();
      event.stopPropagation();
      const pos = enabledIndices.indexOf(focusedIndex);
      const next = pos < 0 ? 0 : (pos + 1) % enabledIndices.length;
      setFocusedIndex(enabledIndices[next]);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const pos = enabledIndices.indexOf(focusedIndex);
      const next =
        pos < 0
          ? enabledIndices.length - 1
          : (pos - 1 + enabledIndices.length) % enabledIndices.length;
      setFocusedIndex(enabledIndices[next]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      const item = items[focusedIndex];
      if (item?.enabled) onActivate(item, focusedIndex);
    }
  };
}
