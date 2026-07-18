import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from 'react';

interface FloatingGraphPanelProps {
  title: string;
  children: ReactNode;
  boundsRef: RefObject<HTMLElement>;
  className?: string;
  contentClassName?: string;
  testId?: string;
  dragHandleTestId?: string;
}

interface DragState {
  startClientX: number;
  startClientY: number;
  startLeft: number;
  startTop: number;
}

const PANEL_MARGIN = 12;

export function FloatingGraphPanel({
  title,
  children,
  boundsRef,
  className = '',
  contentClassName = '',
  testId,
  dragHandleTestId,
}: FloatingGraphPanelProps): JSX.Element {
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);

  const clampPosition = useCallback((left: number, top: number): { left: number; top: number } => {
    const bounds = boundsRef.current;
    const panel = panelRef.current;
    if (!bounds || !panel) return { left, top };

    const maxLeft = Math.max(PANEL_MARGIN, bounds.clientWidth - panel.offsetWidth - PANEL_MARGIN);
    const maxTop = Math.max(PANEL_MARGIN, bounds.clientHeight - panel.offsetHeight - PANEL_MARGIN);
    return {
      left: Math.min(Math.max(PANEL_MARGIN, left), maxLeft),
      top: Math.min(Math.max(PANEL_MARGIN, top), maxTop),
    };
  }, [boundsRef]);

  useEffect(() => {
    if (!position) return;
    setPosition(clampPosition(position.left, position.top));
  }, [clampPosition, position?.left, position?.top]);

  const handleDragStart = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 && event.button !== undefined) return;
    const bounds = boundsRef.current;
    const panel = panelRef.current;
    if (!bounds || !panel) return;

    const boundsRect = bounds.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const start = clampPosition(panelRect.left - boundsRect.left, panelRect.top - boundsRect.top);
    setPosition(start);
    dragRef.current = {
      startClientX: event.clientX,
      startClientY: event.clientY,
      startLeft: start.left,
      startTop: start.top,
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, [boundsRef, clampPosition]);

  const handleDragMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const dragState = dragRef.current;
    if (!dragState) return;
    setPosition(clampPosition(
      dragState.startLeft + event.clientX - dragState.startClientX,
      dragState.startTop + event.clientY - dragState.startClientY,
    ));
    event.preventDefault();
    event.stopPropagation();
  }, [clampPosition]);

  const handleDragEnd = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return (
    <div
      ref={panelRef}
      data-testid={testId}
      className={`absolute z-10 h-[280px] w-[420px] rounded border border-gray-700 bg-gray-900/95 overflow-hidden shadow-lg ${className}`}
      style={position ? { left: position.left, top: position.top } : { top: PANEL_MARGIN, right: PANEL_MARGIN }}
      onClick={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div
        data-testid={dragHandleTestId}
        className="cursor-move select-none px-2 py-1 text-[11px] text-gray-300 border-b border-gray-700"
        onPointerDown={handleDragStart}
        onPointerMove={handleDragMove}
        onPointerUp={handleDragEnd}
        onPointerCancel={handleDragEnd}
      >
        {title}
      </div>
      <div className={contentClassName}>
        {children}
      </div>
    </div>
  );
}
