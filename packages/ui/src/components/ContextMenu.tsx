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

import { useCallback, useEffect, useMemo, useRef, useState, useLayoutEffect } from 'react';
import type { TaskState } from '../types.js';
import { getMenuItems, type MenuItem } from '../lib/context-menu-items.js';
import {
  firstEnabledMenuIndex,
  isMenuActivationKey,
  nextEnabledMenuIndex,
} from '../lib/menu-keyboard.js';
import { EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE } from '../isExperimentSpawnPivot.js';

const MORE_ITEM_ID = '__more__';
const MORE_ACTION = '__expandMore__';

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
  const initialFocusAppliedRef = useRef(false);

  const items = getMenuItems(task, { agents: ['claude', 'codex'] });

  const availableItems = items.filter((item) => {
    if (item.action === 'onRecreateTask' && !onRecreateTask) return false;
    if (item.action === 'onFix' && !onFix) return false;
    if (item.action === 'onCancel' && !onCancel) return false;
    return true;
  });

  const safeItems = availableItems.filter((item) => item.variant !== 'danger');
  const dangerItems = availableItems.filter((item) => item.variant === 'danger');

  const navigableItems: MenuItem[] = useMemo(() => {
    if (showMore) return [...safeItems, ...dangerItems];
    if (dangerItems.length === 0) return safeItems;
    return [
      ...safeItems,
      {
        id: MORE_ITEM_ID,
        label: 'More',
        enabled: true,
        action: MORE_ACTION,
      },
    ];
    // safeItems / dangerItems identity changes each render — they are derived
    // from props, so it's safe to depend on length plus showMore.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showMore, safeItems.length, dangerItems.length]);

  const firstEnabled = firstEnabledMenuIndex(navigableItems);

  // Focus the menu container so document-level keydown listeners in App can't
  // steal ArrowUp/ArrowDown/Enter/Space while the menu is open.
  useLayoutEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // One-shot: park the highlight on the first enabled entry when the menu
  // appears. We don't want this re-running after the user navigates or after
  // More expands (which is handled explicitly below).
  useEffect(() => {
    if (initialFocusAppliedRef.current) return;
    if (firstEnabled >= 0) {
      initialFocusAppliedRef.current = true;
      setFocusedIndex(firstEnabled);
    }
  }, [firstEnabled]);

  useLayoutEffect(() => {
    if (!menuRef.current) return;

    const rect = menuRef.current.getBoundingClientRect();
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    let left = x;
    let top = y;

    if (rect.right > viewportWidth) {
      left = x - rect.width;
    }
    if (rect.bottom > viewportHeight) {
      top = y - rect.height;
    }

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

  const activateMoreAndFocusFirstDanger = useCallback(() => {
    setShowMore(true);
    const offsetIntoDanger = firstEnabledMenuIndex(dangerItems);
    if (offsetIntoDanger >= 0) {
      setFocusedIndex(safeItems.length + offsetIntoDanger);
    }
  }, [dangerItems, safeItems.length]);

  const activateItem = useCallback(
    (item: MenuItem) => {
      if (!item.enabled) return;

      if (item.action === MORE_ACTION) {
        activateMoreAndFocusFirstDanger();
        return;
      }

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
    },
    [
      activateMoreAndFocusFirstDanger,
      onCancel,
      onClose,
      onFix,
      onOpenTerminal,
      onRecreateTask,
      onReplace,
      onRestart,
      task.id,
    ]
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      const next = nextEnabledMenuIndex(navigableItems, focusedIndex, 1);
      if (next < 0) return;
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(next);
      return;
    }
    if (e.key === 'ArrowUp') {
      const next = nextEnabledMenuIndex(navigableItems, focusedIndex, -1);
      if (next < 0) return;
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(next);
      return;
    }
    if (isMenuActivationKey(e.key)) {
      const item = navigableItems[focusedIndex];
      if (!item || !item.enabled) return;
      e.preventDefault();
      e.stopPropagation();
      activateItem(item);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  };

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
      {navigableItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;
        const tooltip = !item.enabled && item.id === 'open-terminal'
          ? EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE
          : undefined;
        const isMoreItem = item.id === MORE_ITEM_ID;
        const classes = isMoreItem
          ? 'w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700'
          : `w-full text-left px-3 py-1.5 text-sm ${getVariantClasses(item.variant, item.enabled)}`;

        return (
          <div key={item.id}>
            {item.separator === 'task' && renderSeparator('Task')}
            {item.separator === 'danger' && renderSeparator('Danger')}
            {isMoreItem && <div className="border-t border-gray-600 my-1" />}
            <button
              role="menuitem"
              aria-disabled={!item.enabled}
              className={`${classes} ${isFocused ? 'bg-gray-700' : ''}`}
              onClick={() => activateItem(item)}
              onMouseEnter={() => setFocusedIndex(idx)}
              disabled={!item.enabled}
              title={tooltip}
              tabIndex={-1}
            >
              {item.label}
            </button>
          </div>
        );
      })}
    </div>
  );
}
