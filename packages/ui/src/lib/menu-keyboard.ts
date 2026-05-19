import { useEffect } from 'react';
import type { KeyboardEvent, RefObject } from 'react';

export interface KeyboardMenuItem {
  enabled: boolean;
  activate: () => void;
}

const HANDLED_MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

export function useMenuKeyboard<T extends HTMLElement>(
  menuRef: RefObject<T>,
  items: KeyboardMenuItem[],
  activeIndex: number,
  setActiveIndex: (index: number) => void,
) {
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, [menuRef]);

  const handleKeyDown = (event: KeyboardEvent) => {
    if (!HANDLED_MENU_KEYS.has(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    const enabledIndices = items
      .map((item, index) => (item.enabled ? index : -1))
      .filter((index) => index >= 0);
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

    const item = items[activeIndex];
    if (item?.enabled) item.activate();
  };

  return handleKeyDown;
}
