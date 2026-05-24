/**
 * Shared keyboard-navigation helpers for the right-click context menus
 * (ContextMenu and WorkflowContextMenu).
 *
 * Both menus share the same model — a flat list of items, some of which can
 * be disabled — so the navigation logic is factored out here.
 */

export interface MenuNavOptions<T> {
  items: readonly T[];
  isEnabled: (item: T) => boolean;
  focusedIndex: number;
  setFocusedIndex: (idx: number) => void;
  activate: (item: T, idx: number) => void;
}

export function isMenuNavKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === ' ';
}

/**
 * Handle ArrowUp/ArrowDown/Enter/Space on a menu. Returns true when the key
 * was consumed; callers should ignore other keys. Always calls preventDefault
 * and stopPropagation for handled keys so the App-level graph shortcuts do
 * not also act on them.
 */
export function handleMenuKeyDown<T>(
  event: React.KeyboardEvent | KeyboardEvent,
  options: MenuNavOptions<T>,
): boolean {
  if (!isMenuNavKey(event.key)) return false;

  event.preventDefault();
  event.stopPropagation();

  const enabledIndices = options.items
    .map((item, idx) => (options.isEnabled(item) ? idx : -1))
    .filter((idx) => idx >= 0);

  if (enabledIndices.length === 0) return true;

  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const direction = event.key === 'ArrowDown' ? 1 : -1;
    const currentPos = enabledIndices.indexOf(options.focusedIndex);
    const nextPos =
      currentPos === -1
        ? 0
        : (currentPos + direction + enabledIndices.length) % enabledIndices.length;
    options.setFocusedIndex(enabledIndices[nextPos]);
    return true;
  }

  // Enter or Space activates the focused item if it is enabled.
  const item = options.items[options.focusedIndex];
  if (item !== undefined && options.isEnabled(item)) {
    options.activate(item, options.focusedIndex);
  }
  return true;
}
