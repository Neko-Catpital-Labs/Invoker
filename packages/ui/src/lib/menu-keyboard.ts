export interface MenuKeyboardItem {
  enabled: boolean;
}

export function isMenuKeyboardKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || isMenuActivationKey(key);
}

export function isMenuActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar';
}

export function firstEnabledMenuIndex(
  items: readonly MenuKeyboardItem[],
  startAt = 0,
): number {
  if (items.length === 0) return -1;

  const normalizedStart = ((startAt % items.length) + items.length) % items.length;
  for (let offset = 0; offset < items.length; offset += 1) {
    const index = (normalizedStart + offset) % items.length;
    if (items[index]?.enabled) return index;
  }

  return -1;
}

export function nextEnabledMenuIndex(
  items: readonly MenuKeyboardItem[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const enabledIndices = items
    .map((item, index) => (item.enabled ? index : -1))
    .filter((index) => index >= 0);

  if (enabledIndices.length === 0) return currentIndex;

  const currentPosition = enabledIndices.indexOf(currentIndex);
  if (currentPosition === -1) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }

  const nextPosition = (currentPosition + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPosition];
}
