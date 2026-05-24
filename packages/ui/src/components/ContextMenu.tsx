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

import { Fragment, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { TaskState } from '../types.js';
import { getMenuItems, type MenuItem } from '../lib/context-menu-items.js';
import { buildMenuKeyHandler } from '../lib/menu-keyboard.js';
import { EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE } from '../isExperimentSpawnPivot.js';

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

const MORE_ITEM_ID = '__more__';

interface MoreSentinel {
  id: typeof MORE_ITEM_ID;
  label: 'More';
  enabled: true;
  isMore: true;
}

type NavItem = (MenuItem & { isMore?: false }) | MoreSentinel;

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
  const hasMoreItem = dangerItems.length > 0 && !showMore;

  const moreSentinel: MoreSentinel = {
    id: MORE_ITEM_ID,
    label: 'More',
    enabled: true,
    isMore: true,
  };

  const renderedItems: NavItem[] = showMore
    ? [...safeItems, ...dangerItems]
    : hasMoreItem
      ? [...safeItems, moreSentinel]
      : [...safeItems];

  // Auto-focus the menu on mount and set initial highlight.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    const firstEnabled = renderedItems.findIndex((item) => item.enabled);
    if (firstEnabled >= 0) setFocusedIndex(firstEnabled);
    // Intentionally only runs on mount; later focus moves are explicit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When More expands, jump highlight to the first newly-revealed item
  // (the first danger item, which sits right after the safe items) and
  // restore focus to the menu container so keyboard nav keeps working
  // even if the user activated More with the mouse.
  useEffect(() => {
    if (!showMore) return;
    setFocusedIndex(safeItems.length);
    menuRef.current?.focus({ preventScroll: true });
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
  }, [x, y, showMore]);

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

  const expandMore = () => {
    setShowMore(true);
  };

  // Handle a real menu item activation (not the "More" sentinel)
  const handleItemClick = (item: MenuItem) => {
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

  const handleKeyDown = buildMenuKeyHandler<NavItem>({
    items: renderedItems,
    focusedIndex,
    setFocusedIndex,
    onActivate: (item) => {
      if ('isMore' in item && item.isMore) {
        expandMore();
        return;
      }
      handleItemClick(item);
    },
  });

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

        if ('isMore' in item && item.isMore) {
          return (
            <Fragment key={item.id}>
              <div className="border-t border-gray-600 my-1" />
              <button
                role="menuitem"
                className={`w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 ${
                  isFocused ? 'bg-gray-700' : ''
                }`}
                onClick={expandMore}
                onMouseEnter={() => setFocusedIndex(idx)}
              >
                More
              </button>
            </Fragment>
          );
        }

        const menuItem = item;
        const tooltip =
          !menuItem.enabled && menuItem.id === 'open-terminal'
            ? EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE
            : undefined;

        return (
          <Fragment key={menuItem.id}>
            {menuItem.separator === 'task' && renderSeparator('Task')}
            {menuItem.separator === 'danger' && renderSeparator('Danger')}
            <button
              role="menuitem"
              aria-disabled={!menuItem.enabled}
              className={`w-full text-left px-3 py-1.5 text-sm ${getVariantClasses(
                menuItem.variant,
                menuItem.enabled,
              )} ${isFocused ? 'bg-gray-700' : ''}`}
              onClick={() => handleItemClick(menuItem)}
              onMouseEnter={() => setFocusedIndex(idx)}
              disabled={!menuItem.enabled}
              title={tooltip}
            >
              {menuItem.label}
            </button>
          </Fragment>
        );
      })}
    </div>
  );
}
