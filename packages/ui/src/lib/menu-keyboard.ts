/**
 * Keyboard navigation helpers shared by context menus.
 *
 * Both `ContextMenu` and the App-local `WorkflowContextMenu` need to cycle a
 * highlight through enabled entries with ArrowUp/ArrowDown, skipping disabled
 * actions. Centralizing that math here keeps the two menus consistent and
 * removes the duplication that was tempting copy-paste before.
 */

export interface KeyboardMenuEntry {
  enabled: boolean;
}

export function firstEnabledMenuIndex<T extends KeyboardMenuEntry>(items: readonly T[]): number {
  return items.findIndex((item) => item.enabled);
}

export function nextEnabledMenuIndex<T extends KeyboardMenuEntry>(
  items: readonly T[],
  currentIndex: number,
  direction: 1 | -1
): number {
  const enabledIndices: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) enabledIndices.push(i);
  }
  if (enabledIndices.length === 0) return -1;
  const position = enabledIndices.indexOf(currentIndex);
  if (position < 0) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }
  const nextPosition = (position + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPosition];
}

export function isMenuActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar';
}

export function isMenuNavigationKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || isMenuActivationKey(key);
}
