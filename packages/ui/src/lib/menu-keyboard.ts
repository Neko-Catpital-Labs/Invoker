/**
 * menu-keyboard — Shared keyboard-navigation helpers for context menus.
 *
 * Both the task ContextMenu and the WorkflowContextMenu present a vertical
 * list of entries (some disabled) that must be navigable with the arrow keys
 * and activatable with Enter/Space. This module centralizes the index math and
 * the "which keys does a menu own" predicate so both menus behave identically
 * and the App-level graph shortcut handler can defer to any open menu.
 */

/** Keys an open, focused menu claims for navigation/activation. */
export const MENU_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'Enter', ' '] as const;

/** True when `key` is one a focused menu should handle (and the graph should ignore). */
export function isMenuNavKey(key: string): boolean {
  return (MENU_NAV_KEYS as readonly string[]).includes(key);
}

export type MenuKeyResult =
  | { type: 'none' }
  | { type: 'move'; index: number }
  | { type: 'activate'; index: number };

/**
 * Resolve a keydown against a menu whose entries' enabled state is described by
 * `enabledFlags`. ArrowUp/ArrowDown cycle through enabled indices — wrapping
 * around the ends and skipping disabled entries; Enter/Space activate the
 * current entry when it is enabled. When `currentIndex` is not itself enabled,
 * arrow movement falls onto the first (down) or last (up) enabled entry. Any
 * other key, or navigation with no enabled entries, yields `none`.
 */
export function resolveMenuKey(
  key: string,
  currentIndex: number,
  enabledFlags: boolean[],
): MenuKeyResult {
  const enabledIndices = enabledFlags
    .map((enabled, idx) => (enabled ? idx : -1))
    .filter((idx) => idx >= 0);

  if (enabledIndices.length === 0) return { type: 'none' };

  if (key === 'ArrowDown' || key === 'ArrowUp') {
    const step = key === 'ArrowDown' ? 1 : -1;
    const pos = enabledIndices.indexOf(currentIndex);
    const nextPos =
      pos < 0
        ? step === 1
          ? 0
          : enabledIndices.length - 1
        : (pos + step + enabledIndices.length) % enabledIndices.length;
    return { type: 'move', index: enabledIndices[nextPos] };
  }

  if (key === 'Enter' || key === ' ') {
    if (enabledFlags[currentIndex]) return { type: 'activate', index: currentIndex };
    return { type: 'none' };
  }

  return { type: 'none' };
}

/** Focus a menu container on open without scrolling the surrounding viewport. */
export function focusMenuElement(element: HTMLElement | null): void {
  element?.focus({ preventScroll: true });
}
