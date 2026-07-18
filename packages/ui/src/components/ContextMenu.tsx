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

import { useCallback, useEffect, useRef, useState, useLayoutEffect } from 'react';
import type { TaskState } from '../types.js';
import { getMenuItems, type MenuItem } from '../lib/context-menu-items.js';
import { EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE } from '../isExperimentSpawnPivot.js';

interface ContextMenuProps {
  x: number;
  y: number;
  task: TaskState;
  onRestart: (taskId: string) => void;
  onReplace: (taskId: string) => void;
  onOpenTerminal: (taskId: string) => void;
  onRecreateTask?: (taskId: string) => void;
  onRecreateDownstream?: (taskId: string) => void;
  onFix?: (taskId: string, agentName: string) => void;
  onCancel?: (taskId: string) => void;
  onDelete?: (taskId: string) => void;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  autoFocus?: boolean;
}

function stopMenuKeyboardEvent(e: KeyboardEvent | React.KeyboardEvent) {
  e.preventDefault();
  e.stopPropagation();
  if ('stopImmediatePropagation' in e) {
    e.stopImmediatePropagation();
  } else {
    e.nativeEvent.stopImmediatePropagation?.();
  }
}

const TASK_CONTEXT_MENU_Z_INDEX = 1100;

export function ContextMenu({
  x,
  y,
  task,
  onRestart,
  onReplace,
  onOpenTerminal,
  onRecreateTask,
  onRecreateDownstream,
  onFix,
  onCancel,
  onDelete,
  onClose,
  autoFocus = false,
}: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const moreButtonRef = useRef<HTMLButtonElement | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);

  // Generate menu items
  const items = getMenuItems(task, { agents: ['claude', 'codex'] });

  // Filter items based on available handlers
  const availableItems = items.filter((item) => {
    if (item.action === 'onRecreateTask' && !onRecreateTask) return false;
    if (item.action === 'onRecreateDownstream' && !onRecreateDownstream) return false;
    if (item.action === 'onFix' && !onFix) return false;
    if (item.action === 'onCancel' && !onCancel) return false;
    if (item.action === 'onDelete' && !onDelete) return false;
    return true;
  });

  const safeItems = availableItems.filter((item) => item.variant !== 'danger');
  const dangerItems = availableItems.filter((item) => item.variant === 'danger');
  const hasMoreButton = dangerItems.length > 0 && !showMore;
  const renderedItems: MenuItem[] = showMore ? [...safeItems, ...dangerItems] : safeItems;
  const moreButtonIndex = renderedItems.length;
  const focusableIndices = [
    ...renderedItems
      .map((item, idx) => (item.enabled ? idx : -1))
      .filter((idx) => idx >= 0),
    ...(hasMoreButton ? [moreButtonIndex] : []),
  ];

  // Find first enabled item index
  const firstEnabledIndex = focusableIndices[0] ?? -1;

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
  }, []);

  // Auto-focus first enabled item on mount
  useEffect(() => {
    if (firstEnabledIndex >= 0 && !focusableIndices.includes(focusedIndex)) {
      setFocusedIndex(firstEnabledIndex);
    }
  }, [firstEnabledIndex, focusableIndices, focusedIndex]);

  useEffect(() => {
    if (!autoFocus || firstEnabledIndex < 0) return;
    const frame = requestAnimationFrame(() => {
      if (focusedIndex === moreButtonIndex && hasMoreButton) {
        moreButtonRef.current?.focus();
        return;
      }
      itemRefs.current[focusedIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, firstEnabledIndex, focusedIndex, hasMoreButton, moreButtonIndex]);

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
    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
    };
  }, [onClose]);

  // Keyboard navigation
  const handleKeyDown = useCallback((e: KeyboardEvent | React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      stopMenuKeyboardEvent(e);
      onClose({ restoreFocus: autoFocus });
      return;
    }

    if (focusableIndices.length === 0) return;

    if (e.key === 'ArrowDown') {
      stopMenuKeyboardEvent(e);
      const currentPos = Math.max(0, focusableIndices.indexOf(focusedIndex));
      const nextPos = (currentPos + 1) % focusableIndices.length;
      setFocusedIndex(focusableIndices[nextPos]);
    } else if (e.key === 'ArrowUp') {
      stopMenuKeyboardEvent(e);
      const currentPos = Math.max(0, focusableIndices.indexOf(focusedIndex));
      const prevPos = (currentPos - 1 + focusableIndices.length) % focusableIndices.length;
      setFocusedIndex(focusableIndices[prevPos]);
    } else if (e.key === 'Enter' || e.key === ' ') {
      stopMenuKeyboardEvent(e);
      if (focusedIndex === moreButtonIndex && hasMoreButton) {
        setShowMore(true);
        setFocusedIndex(safeItems.length);
        return;
      }
      const item = renderedItems[focusedIndex];
      if (item?.enabled) {
        handleItemClick(item);
      }
    }
  }, [autoFocus, focusableIndices, focusedIndex, hasMoreButton, moreButtonIndex, onClose, renderedItems, safeItems.length]);

  useEffect(() => {
    const handleDocumentKeyDownCapture = (event: KeyboardEvent) => {
      if (
        event.key === 'Escape' ||
        event.key === 'ArrowDown' ||
        event.key === 'ArrowUp' ||
        event.key === 'Enter' ||
        event.key === ' '
      ) {
        handleKeyDown(event);
      }
    };

    document.addEventListener('keydown', handleDocumentKeyDownCapture, true);
    return () => document.removeEventListener('keydown', handleDocumentKeyDownCapture, true);
  }, [handleKeyDown]);

  // Handle menu item click
  function handleItemClick(item: MenuItem) {
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
      case 'onRecreateDownstream':
        onRecreateDownstream?.(task.id);
        break;
      case 'onFix':
        if (item.agentName) {
          onFix?.(task.id, item.agentName);
        }
        break;
      case 'onCancel':
        onCancel?.(task.id);
        break;
      case 'onDelete':
        onDelete?.(task.id);
        break;
    }
    onClose({ restoreFocus: autoFocus });
  }

  // Get variant styles
  const getVariantClasses = (variant?: MenuItem['variant'], enabled?: boolean) => {
    if (!enabled) {
      return 'text-muted-foreground cursor-not-allowed';
    }

    switch (variant) {
      case 'primary':
        return 'text-foreground hover:bg-muted';
      case 'warning':
        return 'text-yellow-300 hover:bg-muted';
      case 'danger':
        return 'text-red-300 hover:bg-muted';
      default:
        return 'text-foreground hover:bg-muted';
    }
  };

  // Render separator
  const renderSeparator = (label: string) => (
    <div className="border-t border-border-strong my-1">
      <div className="text-xs text-muted-foreground text-center py-1">{label}</div>
    </div>
  );

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="task-context-menu"
      className="fixed z-50 bg-secondary border border-border-strong rounded-lg shadow-xl py-1 min-w-[160px]"
      style={{ left: position.left, top: position.top, zIndex: TASK_CONTEXT_MENU_Z_INDEX }}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
      tabIndex={-1}
    >
      {renderedItems.map((item, idx) => {
        const isFocused = idx === focusedIndex;
        const tooltip = !item.enabled && item.id === 'open-terminal'
          ? EXPERIMENT_SPAWN_PIVOT_OPEN_TERMINAL_MESSAGE
          : undefined;

        return (
          <div key={item.id}>
            {item.separator === 'task' && renderSeparator('Task')}
            {item.separator === 'danger' && renderSeparator('Danger')}
            <button
              ref={(element) => {
                itemRefs.current[idx] = element;
              }}
              type="button"
              role="menuitem"
              aria-disabled={!item.enabled}
              className={`w-full text-left px-3 py-1.5 text-sm ${getVariantClasses(
                item.variant,
                item.enabled
              )} ${isFocused ? 'bg-muted' : ''}`}
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
          <div className="border-t border-border-strong my-1" />
          <button
            ref={moreButtonRef}
            type="button"
            role="menuitem"
            className={`w-full text-left px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted ${focusedIndex === moreButtonIndex ? 'bg-muted' : ''}`}
            onClick={() => {
              setShowMore(true);
              setFocusedIndex(safeItems.length);
            }}
            onMouseEnter={() => setFocusedIndex(moreButtonIndex)}
          >
            More
          </button>
        </div>
      )}
    </div>
  );
}
