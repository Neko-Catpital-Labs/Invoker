/**
 * Keyboard navigation helpers shared by Invoker context menus.
 *
 * Cycles ArrowUp/ArrowDown through the enabled-item indices of a flat
 * menu-item list, skipping disabled entries. Used by both the task
 * ContextMenu and the WorkflowContextMenu so the two stay in sync.
 */

export interface KeyboardMenuItem {
  enabled: boolean;
}

export function enabledIndicesOf<T extends KeyboardMenuItem>(items: T[]): number[] {
  const result: number[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].enabled) result.push(i);
  }
  return result;
}

export function firstEnabledIndex<T extends KeyboardMenuItem>(items: T[]): number {
  return items.findIndex((item) => item.enabled);
}

export function nextEnabledIndex<T extends KeyboardMenuItem>(
  items: T[],
  currentIndex: number,
  direction: 1 | -1,
): number {
  const indices = enabledIndicesOf(items);
  if (indices.length === 0) return -1;
  const currentPos = indices.indexOf(currentIndex);
  if (currentPos < 0) {
    return direction === 1 ? indices[0] : indices[indices.length - 1];
  }
  const nextPos = (currentPos + direction + indices.length) % indices.length;
  return indices[nextPos];
}

export function focusMenuContainer(element: HTMLElement | null): void {
  if (!element) return;
  try {
    element.focus({ preventScroll: true });
  } catch {
    element.focus();
  }
}
