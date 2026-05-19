import { useEffect, type KeyboardEvent, type RefObject } from 'react';

export interface MenuKeyboardItem {
  enabled: boolean;
  onSelect: () => void;
}

interface UseMenuKeyboardOptions<T extends HTMLElement> {
  menuRef: RefObject<T | null>;
  items: MenuKeyboardItem[];
  activeIndex: number;
  setActiveIndex: (index: number) => void;
}

const HANDLED_MENU_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ', 'Space', 'Spacebar']);

function firstEnabledIndex(items: MenuKeyboardItem[]): number {
  return items.findIndex((item) => item.enabled);
}

export function useMenuKeyboard<T extends HTMLElement>({
  menuRef,
  items,
  activeIndex,
  setActiveIndex,
}: UseMenuKeyboardOptions<T>) {
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, [menuRef]);

  useEffect(() => {
    const activeItem = items[activeIndex];
    if (activeItem?.enabled) return;

    const firstEnabled = firstEnabledIndex(items);
    if (firstEnabled >= 0) {
      setActiveIndex(firstEnabled);
    }
  }, [activeIndex, items, setActiveIndex]);

  return (event: KeyboardEvent) => {
    if (!HANDLED_MENU_KEYS.has(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    const enabledIndices = items
      .map((item, index) => (item.enabled ? index : -1))
      .filter((index) => index >= 0);

    if (enabledIndices.length === 0) return;

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const currentPosition = enabledIndices.indexOf(activeIndex);
      const nextPosition = event.key === 'ArrowDown'
        ? currentPosition < 0 ? 0 : (currentPosition + 1) % enabledIndices.length
        : currentPosition < 0 ? enabledIndices.length - 1 : (currentPosition - 1 + enabledIndices.length) % enabledIndices.length;
      setActiveIndex(enabledIndices[nextPosition]);
      return;
    }

    const activeItem = items[activeIndex];
    if (activeItem?.enabled) {
      activeItem.onSelect();
    }
  };
}
