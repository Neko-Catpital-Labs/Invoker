import { useCallback, useEffect, useRef, useState } from 'react';
import type React from 'react';

export const MENU_KEYBOARD_KEYS = new Set(['ArrowDown', 'ArrowUp', 'Enter', ' ']);

export interface KeyboardMenuItem {
  enabled: boolean;
  onActivate: () => void;
}

function firstEnabledIndex(items: KeyboardMenuItem[]): number {
  return items.findIndex((item) => item.enabled);
}

function moveEnabledIndex(items: KeyboardMenuItem[], currentIndex: number, direction: 1 | -1): number {
  const enabledIndices = items
    .map((item, index) => (item.enabled ? index : -1))
    .filter((index) => index >= 0);

  if (enabledIndices.length === 0) return -1;

  const currentPosition = enabledIndices.indexOf(currentIndex);
  if (currentPosition < 0) {
    return direction === 1 ? enabledIndices[0] : enabledIndices[enabledIndices.length - 1];
  }

  const startPosition = currentPosition;
  const nextPosition = (startPosition + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPosition] ?? enabledIndices[0];
}

export function useMenuKeyboard<T extends HTMLElement>(items: KeyboardMenuItem[]) {
  const menuRef = useRef<T>(null);
  const [activeIndex, setActiveIndex] = useState(() => firstEnabledIndex(items));

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (items[activeIndex]?.enabled) return;
    setActiveIndex(firstEnabledIndex(items));
  }, [activeIndex, items]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent) => {
    if (!MENU_KEYBOARD_KEYS.has(event.key)) return;

    event.preventDefault();
    event.stopPropagation();

    if (event.key === 'ArrowDown') {
      setActiveIndex((index) => moveEnabledIndex(items, index, 1));
      return;
    }

    if (event.key === 'ArrowUp') {
      setActiveIndex((index) => moveEnabledIndex(items, index, -1));
      return;
    }

    const index = items[activeIndex]?.enabled ? activeIndex : firstEnabledIndex(items);
    if (index >= 0) {
      items[index]?.onActivate();
    }
  }, [activeIndex, items]);

  return {
    activeIndex,
    setActiveIndex,
    menuRef,
    handleKeyDown,
  };
}
