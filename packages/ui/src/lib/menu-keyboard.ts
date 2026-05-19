import { useEffect, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

const MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Spacebar']);

export interface MenuKeyboardOptions<T extends HTMLElement> {
  menuRef: RefObject<T | null>;
  itemCount: number;
  activeIndex: number;
  setActiveIndex: (index: number) => void;
  isItemEnabled: (index: number) => boolean;
  onActivate: (index: number) => void;
}

export function isMenuKeyboardKey(key: string): boolean {
  return MENU_KEYS.has(key);
}

export function useMenuKeyboard<T extends HTMLElement>({
  menuRef,
  itemCount,
  activeIndex,
  setActiveIndex,
  isItemEnabled,
  onActivate,
}: MenuKeyboardOptions<T>): (event: ReactKeyboardEvent) => void {
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      menuRef.current?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [menuRef]);

  return (event: ReactKeyboardEvent) => {
    if (!isMenuKeyboardKey(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    const enabledIndices: number[] = [];
    for (let index = 0; index < itemCount; index += 1) {
      if (isItemEnabled(index)) enabledIndices.push(index);
    }
    if (enabledIndices.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const currentPosition = enabledIndices.includes(activeIndex)
        ? enabledIndices.indexOf(activeIndex)
        : 0;
      const offset = event.key === 'ArrowDown' ? 1 : -1;
      const nextPosition = (currentPosition + offset + enabledIndices.length) % enabledIndices.length;
      setActiveIndex(enabledIndices[nextPosition]);
      return;
    }

    if (isItemEnabled(activeIndex)) {
      onActivate(activeIndex);
    }
  };
}
