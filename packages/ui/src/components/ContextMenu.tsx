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
import { firstEnabledIndex, nextEnabledIndex } from '../lib/menu-keyboard.js';
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

type NavEntry =
  | { kind: 'item'; item: MenuItem; enabled: boolean }
  | { kind: 'more'; enabled: true };

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
  const visibleItems: MenuItem[] = showMore ? [...safeItems, ...dangerItems] : safeItems;

  // Navigable list includes the More button as a virtual trailing entry so
  // ArrowDown/ArrowUp/Enter/Space treat it like any other menu item.
  const navEntries: NavEntry[] = [
    ...visibleItems.map((item) => ({ kind: 'item' as const, item, enabled: item.enabled })),
    ...(hasMoreButton ? [{ kind: 'more' as const, enabled: true as const }] : []),
  ];

  const initialEnabledIndex = firstEnabledIndex(navEntries);

  // Reset focus when the entry set changes (e.g. after More expands).
  useEffect(() => {
    if (initialEnabledIndex >= 0) {
      setFocusedIndex(initialEnabledIndex);
    }
  }, [initialEnabledIndex]);

  // Focus the menu so it owns keyboard input as soon as it opens. preventScroll
  // keeps the surrounding layout from jumping when the click happens near a
  // viewport edge.
  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

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

  // Move highlight to the first newly-revealed enabled entry after More expands.
  const expandMore = () => {
    setShowMore(true);
    const firstDangerIndex = safeItems.length;
    const newEntries: NavEntry[] = [
      ...safeItems.map((item) => ({ kind: 'item' as const, item, enabled: item.enabled })),
      ...dangerItems.map((item) => ({ kind: 'item' as const, item, enabled: item.enabled })),
    ];
    const fallback = firstEnabledIndex(newEntries);
    const target = newEntries[firstDangerIndex]?.enabled ? firstDangerIndex : fallback;
    if (target >= 0) setFocusedIndex(target);
  };

  // Keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(nextEnabledIndex(navEntries, focusedIndex, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setFocusedIndex(nextEnabledIndex(navEntries, focusedIndex, -1));
    } else if (e.key === 'Enter' || e.key === ' ') {
      const entry = navEntries[focusedIndex];
      if (!entry) return;
      e.preventDefault();
      e.stopPropagation();
      if (entry.kind === 'more') {
        expandMore();
      } else if (entry.item.enabled) {
        handleItemClick(entry.item);
      }
    }
  };

  // Handle menu item click
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

  const moreIndex = hasMoreButton ? visibleItems.length : -1;

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
      {visibleItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;
        const tooltip = !item.enabled && item.id === 'open-terminal'
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
                item.enabled
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
      {hasMoreButton && (
        <div>
          <div className="border-t border-gray-600 my-1" />
          <button
            role="menuitem"
            className={`w-full text-left px-3 py-1.5 text-sm text-gray-300 hover:bg-gray-700 ${
              focusedIndex === moreIndex ? 'bg-gray-700' : ''
            }`}
            onClick={expandMore}
            onMouseEnter={() => setFocusedIndex(moreIndex)}
          >
            More
          </button>
        </div>
      )}
    </div>
  );
}
