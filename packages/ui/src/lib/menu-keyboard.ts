/**
 * Shared keyboard-navigation helpers for context menus.
 *
 * Used by ContextMenu (task) and WorkflowContextMenu (workflow) so both menus
 * cycle through enabled items, skip disabled ones, and wrap at the edges.
 */

export function firstEnabledIndex(enabledFlags: readonly boolean[]): number {
  for (let i = 0; i < enabledFlags.length; i++) {
    if (enabledFlags[i]) return i;
  }
  return -1;
}

export function nextEnabledIndex(
  enabledFlags: readonly boolean[],
  current: number,
  direction: 'next' | 'prev',
): number {
  const n = enabledFlags.length;
  if (n === 0) return -1;
  const step = direction === 'next' ? 1 : -1;
  let idx = current;
  for (let i = 0; i < n; i++) {
    idx = (idx + step + n) % n;
    if (enabledFlags[idx]) return idx;
  }
  return -1;
}
