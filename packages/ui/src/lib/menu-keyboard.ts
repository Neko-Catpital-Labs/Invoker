/**
 * menu-keyboard — shared keyboard-navigation helpers for context menus.
 *
 * Both the task ContextMenu and the WorkflowContextMenu need the same three
 * behaviours: focus the menu container on open (so it owns key input), cycle a
 * highlight across only the *enabled* items with ArrowUp/ArrowDown, and treat a
 * common set of keys as menu-owned so they can be intercepted before the
 * App-level graph shortcuts see them. Keeping that logic here avoids duplicating
 * the index math and key matching in two places.
 */

import { useEffect, type RefObject } from 'react';

/** Keys an open menu claims; App graph shortcuts must yield these while open. */
export const MENU_NAVIGATION_KEYS = ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Spacebar'] as const;

/** True when `key` is one the menu handles (navigation or activation). */
export function isMenuNavigationKey(key: string): boolean {
  return (MENU_NAVIGATION_KEYS as readonly string[]).includes(key);
}

/** True for Enter/Space — the activation keys. */
export function isMenuActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

/**
 * Given the indices of currently-enabled items and the currently-highlighted
 * index, return the next index to highlight when moving in `direction`
 * (1 = down, -1 = up). Wraps around, and lands on a sensible end when the
 * current index is not itself enabled (e.g. nothing highlighted yet).
 */
export function nextEnabledIndex(
  enabledIndices: number[],
  current: number,
  direction: 1 | -1,
): number {
  if (enabledIndices.length === 0) return current;
  const pos = enabledIndices.indexOf(current);
  if (pos === -1) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }
  const nextPos = (pos + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}

/**
 * Focus the menu container element once when it mounts, using `preventScroll`
 * so opening a menu near the viewport edge never yanks the graph around.
 */
export function useFocusMenuOnOpen(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, [ref]);
}
