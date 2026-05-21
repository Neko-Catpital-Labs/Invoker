/**
 * Shared keyboard navigation for context menus.
 *
 * - Auto-focuses the menu container on mount and whenever `resetSignal` changes,
 *   so ArrowUp/ArrowDown/Enter/Space are received without an explicit click.
 * - Cycles focus through enabled items only; disabled items are skipped.
 * - Enter and Space activate the focused enabled item.
 * - Handled keys call preventDefault and stopPropagation so document-level
 *   shortcuts do not also fire.
 */

import { useCallback, useEffect, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, RefObject } from 'react';

export const MENU_OWNED_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
]);

export interface MenuKeyboardItem {
  enabled: boolean;
}

export interface UseMenuKeyboardOptions<T extends MenuKeyboardItem> {
  items: T[];
  containerRef: RefObject<HTMLElement | null>;
  /** Changing this value re-focuses the container; useful for "More" expand. */
  resetSignal?: unknown;
  onActivate: (item: T, index: number) => void;
}

export interface UseMenuKeyboardResult {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  handleKeyDown: (event: ReactKeyboardEvent) => void;
}

function firstEnabledIndex(items: MenuKeyboardItem[]): number {
  return items.findIndex((item) => item.enabled);
}

function enabledIndices(items: MenuKeyboardItem[]): number[] {
  const out: number[] = [];
  items.forEach((item, idx) => {
    if (item.enabled) out.push(idx);
  });
  return out;
}

export function useMenuKeyboard<T extends MenuKeyboardItem>(
  options: UseMenuKeyboardOptions<T>,
): UseMenuKeyboardResult {
  const { items, containerRef, resetSignal, onActivate } = options;
  const [focusedIndex, setFocusedIndex] = useState(() => Math.max(0, firstEnabledIndex(items)));

  useEffect(() => {
    const first = firstEnabledIndex(items);
    if (first >= 0) setFocusedIndex(first);
    containerRef.current?.focus({ preventScroll: true });
    // Intentionally only reacts to resetSignal — focus moves on open and on
    // explicit signal changes (e.g. More expansion), not on every items diff.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetSignal]);

  useEffect(() => {
    const enabled = enabledIndices(items);
    if (enabled.length === 0) return;
    if (!enabled.includes(focusedIndex)) {
      setFocusedIndex(enabled[0]);
    }
  }, [items, focusedIndex]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        const enabled = enabledIndices(items);
        if (enabled.length === 0) return;
        event.preventDefault();
        event.stopPropagation();
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const currentPos = enabled.indexOf(focusedIndex);
        const fallback = direction > 0 ? 0 : enabled.length - 1;
        const nextPos =
          currentPos < 0
            ? fallback
            : (currentPos + direction + enabled.length) % enabled.length;
        setFocusedIndex(enabled[nextPos]);
        return;
      }
      if (event.key === 'Enter' || event.key === ' ') {
        const item = items[focusedIndex];
        if (item?.enabled) {
          event.preventDefault();
          event.stopPropagation();
          onActivate(item, focusedIndex);
        }
      }
    },
    [items, focusedIndex, onActivate],
  );

  return { focusedIndex, setFocusedIndex, handleKeyDown };
}
