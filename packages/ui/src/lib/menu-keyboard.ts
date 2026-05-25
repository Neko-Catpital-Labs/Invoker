import type { KeyboardEvent } from 'react';

export function handleMenuKeyDown(
  e: KeyboardEvent,
  enabledIndices: number[],
  focusedIndex: number,
  setFocusedIndex: (index: number) => void,
  onActivate: (index: number) => void,
): void {
  if (enabledIndices.length === 0) return;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    e.stopPropagation();
    const pos = enabledIndices.indexOf(focusedIndex);
    setFocusedIndex(enabledIndices[pos < 0 ? 0 : (pos + 1) % enabledIndices.length]);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    e.stopPropagation();
    const pos = enabledIndices.indexOf(focusedIndex);
    setFocusedIndex(
      enabledIndices[
        pos < 0 ? enabledIndices.length - 1 : (pos - 1 + enabledIndices.length) % enabledIndices.length
      ],
    );
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    e.stopPropagation();
    if (enabledIndices.includes(focusedIndex)) {
      onActivate(focusedIndex);
    }
  }
}
