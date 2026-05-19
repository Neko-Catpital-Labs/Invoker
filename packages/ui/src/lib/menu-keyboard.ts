import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

export interface KeyboardMenuItem {
  enabled: boolean;
  onActivate: () => void;
}

interface UseMenuKeyboardOptions<T extends HTMLElement> {
  menuRef: RefObject<T | null>;
  items: KeyboardMenuItem[];
  focusedIndex: number;
  setFocusedIndex: (index: number) => void;
  onClose: () => void;
}

const HANDLED_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

function stopMenuKeyEvent(event: Pick<KeyboardEvent | ReactKeyboardEvent, 'preventDefault' | 'stopPropagation'>) {
  event.preventDefault();
  event.stopPropagation();
}

export function isMenuKeyboardKey(key: string): boolean {
  return HANDLED_KEYS.has(key);
}

export function useMenuKeyboard<T extends HTMLElement>({
  menuRef,
  items,
  focusedIndex,
  setFocusedIndex,
  onClose,
}: UseMenuKeyboardOptions<T>) {
  const enabledIndices = items
    .map((item, index) => (item.enabled ? index : -1))
    .filter((index) => index >= 0);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, [menuRef]);

  useEffect(() => {
    if (enabledIndices.length === 0) return;
    if (!enabledIndices.includes(focusedIndex)) {
      setFocusedIndex(enabledIndices[0]);
    }
  }, [enabledIndices, focusedIndex, setFocusedIndex]);

  const onKeyDown = (event: ReactKeyboardEvent<T>) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      onClose();
      return;
    }

    if (!isMenuKeyboardKey(event.key)) return;

    stopMenuKeyEvent(event);
    if (enabledIndices.length === 0) return;

    const currentEnabledPosition = enabledIndices.includes(focusedIndex)
      ? enabledIndices.indexOf(focusedIndex)
      : 0;

    if (event.key === 'ArrowDown') {
      setFocusedIndex(enabledIndices[(currentEnabledPosition + 1) % enabledIndices.length]);
      return;
    }

    if (event.key === 'ArrowUp') {
      setFocusedIndex(enabledIndices[(currentEnabledPosition - 1 + enabledIndices.length) % enabledIndices.length]);
      return;
    }

    items[focusedIndex]?.onActivate();
  };

  return { onKeyDown };
}
