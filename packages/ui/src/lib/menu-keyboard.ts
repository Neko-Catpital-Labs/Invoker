/**
 * Shared keyboard navigation helpers for context menus.
 *
 * Both ContextMenu and WorkflowContextMenu cycle a highlight through enabled
 * entries with ArrowUp/ArrowDown and activate the highlighted entry with Enter
 * or Space. These helpers keep that cycling logic consistent across menus.
 */

export interface KeyboardMenuEntry {
  enabled: boolean;
}

export function firstEnabledIndex<T extends KeyboardMenuEntry>(entries: readonly T[]): number {
  return entries.findIndex((entry) => entry.enabled);
}

export function cycleEnabledIndex<T extends KeyboardMenuEntry>(
  entries: readonly T[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const enabled: number[] = [];
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].enabled) enabled.push(i);
  }
  if (enabled.length === 0) return currentIndex;
  const currentPos = enabled.indexOf(currentIndex);
  if (currentPos === -1) {
    return direction === 1 ? enabled[0] : enabled[enabled.length - 1];
  }
  const nextPos = (currentPos + direction + enabled.length) % enabled.length;
  return enabled[nextPos];
}

export function isMenuNavigationKey(key: string): boolean {
  return key === 'ArrowUp' || key === 'ArrowDown' || key === 'Enter' || key === ' ';
}
