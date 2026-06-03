const MENU_ITEM_SELECTOR = 'button[role="menuitem"]:not(:disabled):not([aria-disabled="true"])';

interface MenuKeyboardEvent {
  key: string;
  preventDefault: () => void;
  stopPropagation?: () => void;
}

export function getEnabledMenuButtons(menu: HTMLElement | null): HTMLButtonElement[] {
  if (!menu) return [];
  return [...menu.querySelectorAll<HTMLButtonElement>(MENU_ITEM_SELECTOR)];
}

export function focusFirstEnabledMenuButton(menu: HTMLElement | null): void {
  getEnabledMenuButtons(menu)[0]?.focus();
}

export function handleMenuKeyboardEvent(event: MenuKeyboardEvent, menu: HTMLElement | null): boolean {
  const buttons = getEnabledMenuButtons(menu);
  if (buttons.length === 0) return false;

  const activeElement = menu?.ownerDocument.activeElement;
  const currentIndex = buttons.findIndex((button) => button === activeElement);

  if (event.key === 'ArrowDown') {
    event.preventDefault();
    event.stopPropagation?.();
    const nextIndex = currentIndex >= 0 ? (currentIndex + 1) % buttons.length : 0;
    buttons[nextIndex]?.focus();
    return true;
  }

  if (event.key === 'ArrowUp') {
    event.preventDefault();
    event.stopPropagation?.();
    const previousIndex = currentIndex >= 0
      ? (currentIndex - 1 + buttons.length) % buttons.length
      : buttons.length - 1;
    buttons[previousIndex]?.focus();
    return true;
  }

  if (event.key === 'Enter' || event.key === ' ' || event.key === 'Spacebar') {
    event.preventDefault();
    event.stopPropagation?.();
    buttons[currentIndex >= 0 ? currentIndex : 0]?.click();
    return true;
  }

  return false;
}
