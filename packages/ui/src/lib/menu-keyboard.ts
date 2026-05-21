/**
 * Shared keyboard helpers for context menus.
 *
 * Both the task ContextMenu and the workflow context menu in App use the same
 * cycle-through-enabled-items logic; this helper keeps that single source of
 * truth so the menus stay in sync.
 */

export type MenuKeyboardDirection = 'next' | 'prev';

/**
 * Return the next enabled index in `enabledFlags`, cycling through the list.
 * Skips disabled entries. Returns -1 if no entries are enabled.
 */
export function nextEnabledIndex(
  enabledFlags: readonly boolean[],
  currentIndex: number,
  direction: MenuKeyboardDirection,
): number {
  const length = enabledFlags.length;
  if (length === 0) return -1;
  const step = direction === 'next' ? 1 : -1;
  for (let offset = 1; offset <= length; offset++) {
    const candidate = (((currentIndex + step * offset) % length) + length) % length;
    if (enabledFlags[candidate]) return candidate;
  }
  return -1;
}

/** Keys the open context menu should own (App graph shortcuts must defer). */
export const MENU_OWNED_KEYS: ReadonlySet<string> = new Set([
  'ArrowUp',
  'ArrowDown',
  'Enter',
  ' ',
]);
