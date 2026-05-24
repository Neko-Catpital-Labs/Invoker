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

import { useEffect, useRef, useState, useLayoutEffect, useMemo } from 'react';
import type { TaskState } from '../types.js';
import { getMenuItems, type MenuItem } from '../lib/context-menu-items.js';
import { findFirstEnabledIndex, findNextEnabledIndex } from '../lib/menu-keyboard.js';
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
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);

  const { renderedItems, safeItemCount } = useMemo(() => {
    const items = getMenuItems(task, { agents: ['claude', 'codex'] }).filter((item) => {
      if (item.action === 'onRecreateTask' && !onRecreateTask) return false;
      if (item.action === 'onFix' && !onFix) return false;
      if (item.action === 'onCancel' && !onCancel) return false;
      return true;
    });
    const safe = items.filter((item) => item.variant !== 'danger');
    const danger = items.filter((item) => item.variant === 'danger');
    const baseItems: MenuItem[] = showMore ? [...safe, ...danger] : [...safe];
    if (!showMore && danger.length > 0) {
      baseItems.push({
        id: MORE_ITEM_ID,
        label: 'More',
        enabled: true,
        action: MORE_ITEM_ID,
      });
    }
    return { renderedItems: baseItems, safeItemCount: safe.length };
  }, [task, onRecreateTask, onFix, onCancel, showMore]);

  const [focusedIndex, setFocusedIndex] = useState(() => findFirstEnabledIndex(renderedItems));

  // Focus the menu on open and after More expands, so keyboard events reach
  // the menu's onKeyDown handler instead of leaking to the document listener.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, [showMore]);

  // Viewport clamping: flip if menu overflows bottom or right
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

  const handleItemClick = (item: MenuItem) => {
    if (!item.enabled) return;

    if (item.action === MORE_ITEM_ID) {
      setShowMore(true);
      // After expansion, deterministically focus the first newly revealed item
      // (which lives at safeItemCount in the post-expand list).
      setFocusedIndex(safeItemCount);
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
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(findNextEnabledIndex(renderedItems, focusedIndex, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(findNextEnabledIndex(renderedItems, focusedIndex, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      const item = renderedItems[focusedIndex];
      if (item?.enabled) {
        handleItemClick(item);
      }
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
      className="fixed z-50 bg-gray-800 border border-gray-600 rounded-lg shadow-xl py-1 min-w-[160px] outline-none"
      style={{ left: position.left, top: position.top }}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      tabIndex={-1}
    >
      {renderedItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;
        const isMore = item.action === MORE_ITEM_ID;
        const tooltip = !item.enabled && item.id === 'open-terminal'
          ? EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE
          : undefined;

        return (
          <div key={item.id}>
            {item.separator === 'task' && renderSeparator('Task')}
            {item.separator === 'danger' && renderSeparator('Danger')}
            {isMore && <div className="border-t border-gray-600 my-1" />}
            <button
              role="menuitem"
              aria-disabled={!item.enabled}
              data-focused={isFocused ? 'true' : 'false'}
              className={`w-full text-left px-3 py-1.5 text-sm ${
                isMore
                  ? 'text-gray-300 hover:bg-gray-700'
                  : getVariantClasses(item.variant, item.enabled)
              } ${isFocused ? 'bg-gray-700' : ''}`}
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
