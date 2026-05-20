/**
 * Shared keyboard helpers for context menus.
 *
 * Both ContextMenu (task right-click) and WorkflowContextMenu use the same
 * focus-on-open and enabled-item cycling pattern, so the small bits of
 * boilerplate live here.
 */

import { useEffect, type RefObject } from 'react';

/** Focus the menu container on mount with preventScroll. */
export function useMenuAutoFocus(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
    // The menu mounts once per open; no other deps should re-focus it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

/**
 * Step through enabled item indices in a fixed direction, wrapping at both
 * ends. Returns the current index unchanged when nothing is enabled.
 */
export function stepEnabledIndex(
  enabledIndices: number[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  if (enabledIndices.length === 0) return currentIndex;
  const pos = enabledIndices.indexOf(currentIndex);
  if (pos === -1) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }
  const nextPos = (pos + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}

/** Keys that an open menu should claim from any ancestor keyboard handler. */
export const MENU_NAV_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
]);
