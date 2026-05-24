/**
 * ContextMenu — Right-click context menu for task nodes in the DAG.
 *
 * Positioned absolutely at the click coordinates.
 * Closes on click-outside or Escape.
 * Features:
 * - Status-adaptive ordering (failed → Fix first, running → Open Terminal first, etc.)
 * - ARIA roles and keyboard navigation (ArrowUp/Down, Enter/Space)
 * - Viewport clamping (flips if overflows bottom/right)
 * - Labeled separators for task and danger zones
 */

import { useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { TaskState } from '../types.js';
import { getMenuItems, type MenuItem } from '../lib/context-menu-items.js';
import { handleMenuKeyDown } from '../lib/menu-keyboard.js';
import { EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE } from '../isExperimentSpawnPivot.js';

const MORE_ITEM_ID = '__more__';
type RenderItem = MenuItem | { id: typeof MORE_ITEM_ID; isMore: true };

function isMoreItem(item: RenderItem): item is { id: typeof MORE_ITEM_ID; isMore: true } {
  return (item as { isMore?: boolean }).isMore === true;
}

interface ContextMenuProps {
  x: number;
  y: number;
  task: TaskState;
  onRestart: (taskId: string) => void;
  onReplace: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onRecreateTask?: (taskId: string) => void;
  onFix?: (taskId: string, agentName: string) => void;
  onCancel?: (taskId: string) => void;
  onClose: () => void;
}

export function ContextMenu({
  x,
  y,
  task,
  onRestart,
  onReplace,
  onOpenTerminal,
  onRecreateTask,
  onFix,
  onCancel,
  onClose,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);

  // Generate menu items
  const items = getMenuItems(task, { agents: ['claude', 'codex'] });

  // Filter items based on available handlers
  const availableItems = items.filter((item) => {
    if (item.action === 'onRecreateTask' && !onRecreateTask) return false;
    if (item.action === 'onFix' && !onFix) return false;
    if (item.action === 'onCancel' && !onCancel) return false;
    return true;
  });

  const safeItems = availableItems.filter((item) => item.variant !== 'danger');
  const dangerItems = availableItems.filter((item) => item.variant === 'danger');
  const hasMoreButton = dangerItems.length > 0 && !showMore;
  const renderedItems: RenderItem[] = showMore
    ? [...safeItems, ...dangerItems]
    : hasMoreButton
      ? [...safeItems, { id: MORE_ITEM_ID, isMore: true }]
      : [...safeItems];

  const isItemEnabled = (item: RenderItem): boolean =>
    isMoreItem(item) ? true : item.enabled;

  // The danger section is appended after the safe items, so once the user
  // expands More we jump the highlight to the first newly-revealed enabled
  // item — that is the most predictable place for the user's eye to land.
  const firstDangerIndex = safeItems.length;

  // Auto-focus first enabled item on mount
  useEffect(() => {
    const firstEnabledIndex = renderedItems.findIndex(isItemEnabled);
    if (firstEnabledIndex >= 0) {
      setFocusedIndex(firstEnabledIndex);
    }
    // Only on mount — subsequent renders manage focus via key handler / More.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the menu container so keystrokes target the menu instead of the
  // App-level document keydown listener.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // When the user expands More, move focus to the first newly-revealed item.
  useEffect(() => {
    if (showMore) {
      const target = renderedItems.findIndex(
        (item, idx) => idx >= firstDangerIndex && isItemEnabled(item),
      );
      if (target >= 0) setFocusedIndex(target);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMore]);

  // Viewport clamping: flip if menu overflows bottom or right
  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = x;
    let top = y;

    // Flip horizontally if overflows right
    if (rect.right > viewportWidth) {
      left = x - rect.width;
    }

    // Flip vertically if overflows bottom
    if (rect.bottom > viewportHeight) {
      top = y - rect.height;
    }

    // Ensure menu stays within viewport (clamp to edges)
    left = Math.max(0, Math.min(left, viewportWidth - rect.width));
    top = Math.max(0, Math.min(top, viewportHeight - rect.height));

    setPosition({ left, top });
  }, [x, y]);

  // Capture-phase outside dismissal stays reliable even if graph layers stop
  // bubbling on mouse/pointer events before they reach document listeners.
  useEffect(() => {
    const dismissFromOutsideTarget = (target: EventTarget | null, button?: number) => {
      if (button !== undefined && button !== 0) return;
      if (menuRef.current && !menuRef.current.contains(target as Node)) {
        onClose();
      }
    };
    const handlePointerDownCapture = (e: PointerEvent) => {
      dismissFromOutsideTarget(e.target, e.button);
    };
    const handleMouseDownCapture = (e: MouseEvent) => {
      dismissFromOutsideTarget(e.target, e.button);
    };
    const handleClickCapture = (e: MouseEvent) => {
      dismissFromOutsideTarget(e.target, e.button);
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('keydown', handleKey);
    };
  }, [onClose]);

  // Handle menu item click
  const handleItemClick = (item: RenderItem) => {
    if (isMoreItem(item)) {
      setShowMore(true);
      return;
    }
    if (!item.enabled) return;

    switch (item.action) {
      case 'onRestart':
        onRestart(task.id);
        break;
      case 'onReplace':
        onReplace(task.id);
        break;
      case 'onOpenTerminal':
        onOpenTerminal(task.id);
        break;
      case 'onRecreateTask':
        onRecreateTask?.(task.id);
        break;
      case 'onFix':
        if (item.agentName) {
          onFix?.(task.id, item.agentName);
        }
        break;
      case 'onCancel':
        onCancel?.(task.id);
        break;
    }
    onClose();
  };

  // Keyboard navigation — shared logic; helper stops propagation so the App's
  // document keydown handler does not also act on these keys.
  const handleKeyDown = (event: React.KeyboardEvent) => {
    handleMenuKeyDown(event, {
      items: renderedItems,
      isEnabled: isItemEnabled,
      focusedIndex,
      setFocusedIndex,
      activate: (item) => handleItemClick(item),
    });
  };

  // Get variant styles
  const getVariantClasses = (variant?: MenuItem['variant'], enabled?: boolean) => {
    if (!enabled) {
      return 'text-gray-500 cursor-not-allowed';
    }

    switch (variant) {
      case 'primary':
        return 'text-blue-300 hover:bg-gray-700';
      case 'warning':
        return 'text-yellow-300 hover:bg-gray-700';
      case 'danger':
        return 'text-red-300 hover:bg-gray-700';
      default:
        return 'text-gray-100 hover:bg-gray-700';
    }
  };

  // Render separator
  const renderSeparator = (label: string) => (
    <div className="border-t border-gray-600 my-1">
      <div className="text-xs text-gray-500 text-center py-1">{label}</div>
    </div>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: position.left, top: position.top }}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      tabIndex={-1}
    >
      {renderedItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;

        if (isMoreItem(item)) {
          return (
            <div key={item.id}>
              <div className="border-t border-gray-600 my-1" />
              <button
                role="menuitem"
                className={`w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 ${
                  isFocused ? 'bg-gray-700' : ''
                }`}
                onClick={() => handleItemClick(item)}
                onMouseEnter={() => setFocusedIndex(idx)}
              >
                More
              </button>
            </div>
          );
        }

        const tooltip =
          !item.enabled && item.id === 'open-terminal'
            ? EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE
            : undefined;

        return (
          <div key={item.id}>
            {item.separator === 'task' && renderSeparator('Task')}
            {item.separator === 'danger' && renderSeparator('Danger')}
            <button
              role="menuitem"
              aria-disabled={!item.enabled}
              className={`w-full text-left px-3 py-1.5 text-sm ${getVariantClasses(
                item.variant,
                item.enabled,
              )} ${isFocused ? 'bg-gray-700' : ''}`}
              onClick={() => handleItemClick(item)}
              onMouseEnter={() => setFocusedIndex(idx)}
              disabled={!item.enabled}
              title={tooltip}
            >
              {item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
