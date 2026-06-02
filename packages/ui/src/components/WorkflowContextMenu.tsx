import { useEffect, useLayoutEffect, useRef, useState } from 'react';

interface WorkflowContextMenuProps {
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
  onCopyWorkflowId: (workflowId: string) => void;
  onClose: () => void;
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
  onCopyWorkflowId,
  onClose,
}: WorkflowContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const [showMore, setShowMore] = useState(false);

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
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('pointerdown', handlePointerDownCapture, true);
    document.addEventListener('mousedown', handleMouseDownCapture, true);
    document.addEventListener('click', handleClickCapture, true);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDownCapture, true);
      document.removeEventListener('mousedown', handleMouseDownCapture, true);
      document.removeEventListener('click', handleClickCapture, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [onClose]);

  const runAction = (action: (workflowId: string) => void) => {
    action(workflowId);
    onClose();
  };

  const buttonClass = 'w-full px-3 py-1.5 text-left text-sm text-gray-100 hover:bg-gray-700';
  const dangerButtonClass = 'w-full px-3 py-1.5 text-left text-sm text-red-300 hover:bg-gray-700';

  return (
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50 min-w-[200px] rounded-lg border border-gray-600 bg-gray-800 py-1 shadow-xl"
      style={{ left: position.left, top: position.top }}
      tabIndex={-1}
      onClick={(event) => event.stopPropagation()}
    >
      <button role="menuitem" onClick={() => runAction(onOpenWorkflow)} className={buttonClass}>
        Open Workflow
      </button>
      <button role="menuitem" onClick={() => runAction(onOpenPr)} className={buttonClass}>
        Open PR
      </button>
      <button role="menuitem" onClick={() => runAction(onRetryWorkflow)} className={buttonClass}>
        Retry Workflow
      </button>
      <button role="menuitem" onClick={() => runAction(onCopyWorkflowId)} className={buttonClass}>
        Copy Workflow ID
      </button>
      {!showMore ? (
        <div>
          <div className="my-1 border-t border-gray-600" />
          <button
            role="menuitem"
            className="w-full px-3 py-1.5 text-left text-sm text-gray-300 hover:bg-gray-700"
            onClick={() => setShowMore(true)}
          >
            More
          </button>
        </div>
      ) : (
        <div>
          <div className="my-1 border-t border-gray-600" />
          <button role="menuitem" onClick={() => runAction(onRebaseRetry)} className={buttonClass}>
            Rebase and Retry
          </button>
          <button role="menuitem" onClick={() => runAction(onRebaseRecreate)} className={dangerButtonClass}>
            Rebase and Recreate
          </button>
          <button role="menuitem" onClick={() => runAction(onRecreateWorkflow)} className={dangerButtonClass}>
            Recreate Workflow
          </button>
          <button role="menuitem" onClick={() => runAction(onCancelWorkflow)} className={dangerButtonClass}>
            Cancel Workflow
          </button>
          <button role="menuitem" onClick={() => runAction(onDeleteWorkflow)} className={dangerButtonClass}>
            Delete Workflow
          </button>
        </div>
      )}
    </div>
  );
}
