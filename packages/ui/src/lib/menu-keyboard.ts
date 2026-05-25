import { useEffect, type RefObject } from 'react';

export function useMenuFocus(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    ref.current?.focus({ preventScroll: true });
  }, []);
}

export function cycleEnabledIndex(
  enabledIndices: number[],
  current: number,
  direction: 'down' | 'up',
): number {
  if (enabledIndices.length === 0) return current;
  const pos = enabledIndices.indexOf(current);
  if (direction === 'down') {
    return enabledIndices[pos === -1 ? 0 : (pos + 1) % enabledIndices.length];
  }
  return enabledIndices[
    pos === -1 ? enabledIndices.length - 1 : (pos - 1 + enabledIndices.length) % enabledIndices.length
  ];
}
