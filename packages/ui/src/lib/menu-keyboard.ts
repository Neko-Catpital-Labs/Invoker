/**
 * useMenuKeyboard — Shared keyboard navigation for popover menus.
 *
 * - Focuses the container on mount (preventScroll) so the menu can receive keys.
 * - Listens for ArrowUp / ArrowDown / Enter / Space at the document capture phase
 *   and calls stopImmediatePropagation, so App-level graph shortcuts (which are
 *   bubble-phase document listeners) cannot also process the same event.
 * - Cycles the focused index through `enabledIndices`, skipping disabled rows.
 *
 * Escape and outside-click dismissal remain the responsibility of the caller.
 */

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';

export interface UseMenuKeyboardOptions {
  containerRef: RefObject<HTMLElement | null>;
  enabledIndices: number[];
  onActivate: (index: number) => void;
}

export interface UseMenuKeyboardResult {
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
}

export function useMenuKeyboard({
  containerRef,
  enabledIndices,
  onActivate,
}: UseMenuKeyboardOptions): UseMenuKeyboardResult {
  const [focusedIndex, setFocusedIndex] = useState<number>(
    enabledIndices.length > 0 ? enabledIndices[0] : -1,
  );

  const enabledIndicesRef = useRef(enabledIndices);
  const focusedIndexRef = useRef(focusedIndex);
  const onActivateRef = useRef(onActivate);
  enabledIndicesRef.current = enabledIndices;
  focusedIndexRef.current = focusedIndex;
  onActivateRef.current = onActivate;

  // Keep focused index inside the current set of enabled items. If items shift
  // (e.g., a "More" section expands), the index naturally falls on whichever
  // row now sits at that position; only reset when the prior focus is no
  // longer activatable.
  useEffect(() => {
    if (enabledIndices.length === 0) {
      if (focusedIndex !== -1) setFocusedIndex(-1);
      return;
    }
    if (!enabledIndices.includes(focusedIndex)) {
      setFocusedIndex(enabledIndices[0]);
    }
  }, [enabledIndices, focusedIndex]);

  useLayoutEffect(() => {
    containerRef.current?.focus({ preventScroll: true });
  }, [containerRef]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const key = event.key;
      if (key !== 'ArrowDown' && key !== 'ArrowUp' && key !== 'Enter' && key !== ' ') {
        return;
      }
      const enabled = enabledIndicesRef.current;
      if (enabled.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();

      const current = focusedIndexRef.current;
      const currentPos = enabled.indexOf(current);

      if (key === 'ArrowDown') {
        const nextPos = currentPos < 0 ? 0 : (currentPos + 1) % enabled.length;
        setFocusedIndex(enabled[nextPos]);
        return;
      }
      if (key === 'ArrowUp') {
        const prevPos = currentPos < 0
          ? enabled.length - 1
          : (currentPos - 1 + enabled.length) % enabled.length;
        setFocusedIndex(enabled[prevPos]);
        return;
      }
      // Enter or Space
      const target = current >= 0 && enabled.includes(current) ? current : enabled[0];
      onActivateRef.current(target);
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, []);

  return { focusedIndex, setFocusedIndex };
}
