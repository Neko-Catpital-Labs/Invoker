import { useState, useCallback, useEffect, useLayoutEffect, useRef } from 'react';

export type ContextMenuCloseOptions = { restoreFocus?: boolean };

export interface WorkflowContextMenuProps {
  x: number;
  y: number;
  workflowId: string;
  onOpenWorkflow: (workflowId: string) => void;
  onOpenPr: (workflowId: string) => void;
  onRetryWorkflow: (workflowId: string) => void;
  onRebaseRetry: (workflowId: string) => void;
  onRebaseRecreate: (workflowId: string) => void;
  onRecreateWorkflow: (workflowId: string) => void;
  onCancelWorkflow: (workflowId: string) => void;
  onDeleteWorkflow: (workflowId: string) => void;
  onDetachWorkflow: (workflowId: string) => void;
  onAttachWorkflow: (workflowId: string) => void;
  onCopyWorkflowId: (workflowId: string) => void;
  /** True when this workflow has exactly one upstream dependency that can be detached from the UI. */
  canDetach: boolean;
  onClose: (options?: ContextMenuCloseOptions) => void;
  autoFocus?: boolean;
}

interface WorkflowMenuItem {
  id: string;
  label: string;
  className: string;
  action: () => void;
  separator?: boolean;
}

function stopMenuKeyboardEvent(event: KeyboardEvent | React.KeyboardEvent) {
  event.preventDefault();
  event.stopPropagation();
  if ('stopImmediatePropagation' in event) {
    event.stopImmediatePropagation();
  } else {
    event.nativeEvent.stopImmediatePropagation?.();
  }
}

export function WorkflowContextMenu({
  x,
  y,
  workflowId,
  onOpenWorkflow,
  onOpenPr,
  onRetryWorkflow,
  onRebaseRetry,
  onRebaseRecreate,
  onRecreateWorkflow,
  onCancelWorkflow,
  onDeleteWorkflow,
  onDetachWorkflow,
  onAttachWorkflow,
  onCopyWorkflowId,
  canDetach,
  onClose,
  autoFocus = false,
}: WorkflowContextMenuProps): JSX.Element {
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);
  const [focusedIndex, setFocusedIndex] = useState(0);

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

  useEffect(() => {
    const dismissFromOutsideTarget = (target: EventTarget | null, button?: number) => {
      if (button !== undefined && button !== 0) return;
      if (menuRef.current && !menuRef.current.contains(target as Node)) {
        onClose();
      }
    };
    const handlePointerDownCapture = (event: PointerEvent) => dismissFromOutsideTarget(event.target, event.button);
    const handleMouseDownCapture = (event: MouseEvent) => dismissFromOutsideTarget(event.target, event.button);
    const handleClickCapture = (event: MouseEvent) => dismissFromOutsideTarget(event.target, event.button);
    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
    };
  }, [onClose]);

  useEffect(() => {
    menuRef.current?.focus({ preventScroll: true });
    setFocusedIndex(0);
    if (autoFocus) return;
    const frame = requestAnimationFrame(() => menuRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);

  const runAction = (action: (workflowId: string) => void) => {
    action(workflowId);
    onClose({ restoreFocus: autoFocus });
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-muted';
  const visibleItems: WorkflowMenuItem[] = [
    { id: 'open-workflow', label: 'Open Workflow', className: buttonClass, action: () => runAction(onOpenWorkflow) },
    { id: 'open-pr', label: 'Open PR', className: buttonClass, action: () => runAction(onOpenPr) },
    { id: 'retry-workflow', label: 'Retry Workflow', className: buttonClass, action: () => runAction(onRetryWorkflow) },
    { id: 'copy-workflow-id', label: 'Copy Workflow ID', className: buttonClass, action: () => runAction(onCopyWorkflowId) },
    ...(!showMore
      ? [{
          id: 'more',
          label: 'More',
          className: 'w-full px-3 py-1.5 text-left text-sm text-muted-foreground hover:bg-muted',
          separator: true,
          action: () => {
            setShowMore(true);
            setFocusedIndex(4);
          },
        }]
      : [
          { id: 'rebase-retry', label: 'Rebase and Retry', className: buttonClass, separator: true, action: () => runAction(onRebaseRetry) },
          { id: 'rebase-recreate', label: 'Rebase and Recreate', className: dangerButtonClass, action: () => runAction(onRebaseRecreate) },
          { id: 'recreate-workflow', label: 'Recreate Workflow', className: dangerButtonClass, action: () => runAction(onRecreateWorkflow) },
          { id: 'cancel-workflow', label: 'Cancel Workflow', className: dangerButtonClass, action: () => runAction(onCancelWorkflow) },
          ...(canDetach
            ? [{ id: 'detach-workflow', label: 'Detach Upstream Workflow', className: dangerButtonClass, action: () => runAction(onDetachWorkflow) }]
            : []),
          { id: 'attach-workflow', label: 'Attach to...', className: buttonClass, action: () => runAction(onAttachWorkflow) },
          { id: 'delete-workflow', label: 'Delete Workflow', className: dangerButtonClass, action: () => runAction(onDeleteWorkflow) },
        ]),
  ];

  useEffect(() => {
    if (focusedIndex >= visibleItems.length) {
      setFocusedIndex(Math.max(0, visibleItems.length - 1));
    }
  }, [focusedIndex, visibleItems.length]);

  useEffect(() => {
    if (!autoFocus || visibleItems.length === 0) return;
    const frame = requestAnimationFrame(() => {
      itemRefs.current[focusedIndex]?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, focusedIndex, visibleItems.length]);

  const handleKeyDown = useCallback((event: KeyboardEvent | React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      stopMenuKeyboardEvent(event);
      onClose({ restoreFocus: autoFocus });
      return;
    }

    if (visibleItems.length === 0) return;

    if (event.key === 'ArrowDown') {
      stopMenuKeyboardEvent(event);
      setFocusedIndex((index) => (index + 1) % visibleItems.length);
      return;
    }
    if (event.key === 'ArrowUp') {
      stopMenuKeyboardEvent(event);
      setFocusedIndex((index) => (index - 1 + visibleItems.length) % visibleItems.length);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      stopMenuKeyboardEvent(event);
      visibleItems[focusedIndex]?.action();
    }
  }, [autoFocus, focusedIndex, onClose, visibleItems]);

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

  return (
    <div
      ref={menuRef}
      role="menu"
      data-testid="workflow-context-menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-border-strong bg-secondary py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      {visibleItems.map((item, index) => (
        <div key={item.id}>
          {item.separator && <div className="my-1 border-t border-border-strong" />}
          <button
            ref={(element) => {
              itemRefs.current[index] = element;
            }}
            type="button"
            role="menuitem"
            onClick={item.action}
            onMouseEnter={() => setFocusedIndex(index)}
            className={`${item.className} ${index === focusedIndex ? 'bg-muted' : ''}`}
          >
            {item.label}
          </button>
        </div>
      ))}
    </div>
  );
}
