export type MenuKeyboardDirection = 'next' | 'previous';

export function isMenuActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Space' || key === 'Spacebar';
}

export function isMenuOwnedKey(key: string): boolean {
  return key === 'ArrowDown' || key === 'ArrowUp' || isMenuActivationKey(key);
}

export function firstEnabledMenuIndex<T>(
  items: readonly T[],
  isEnabled: (item: T) => boolean,
): number {
  return items.findIndex(isEnabled);
}

export function nextEnabledMenuIndex<T>(
  items: readonly T[],
  currentIndex: number,
  direction: MenuKeyboardDirection,
  isEnabled: (item: T) => boolean,
): number {
  const enabledIndices = items
    .map((item, index) => (isEnabled(item) ? index : -1))
    .filter((index) => index >= 0);

  if (enabledIndices.length === 0) return currentIndex;

  const currentPosition = enabledIndices.indexOf(currentIndex);
  if (currentPosition < 0) {
    return direction === 'next'
      ? enabledIndices[0]
      : enabledIndices[enabledIndices.length - 1];
  }

  const offset = direction === 'next' ? 1 : -1;
  const nextPosition = (currentPosition + offset + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPosition];
}
