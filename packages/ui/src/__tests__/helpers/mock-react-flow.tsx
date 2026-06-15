/**
 * Mock @xyflow/react module for jsdom component tests.
 *
 * ReactFlow uses ResizeObserver and getBoundingClientRect which don't work in
 * jsdom. This mock renders nodes as plain divs with the same data-testid
 * attributes that ReactFlow generates, enabling queries like
 * screen.getByTestId('rf__node-task-alpha').
 *
 * Usage in tests:
 *   vi.mock('@xyflow/react', async () => {
 *     const { createReactFlowMock } = await import('./helpers/mock-react-flow.js');
 *     return createReactFlowMock();
 *   });
 */

import React from 'react';
import { vi } from 'vitest';

export function createReactFlowMock() {
  const fitView = vi.fn();
  const setCenter = vi.fn();
  const getZoom = vi.fn(() => 1);
  const getViewport = vi.fn(() => ({ x: 0, y: 0, zoom: 1 }));
  const MockReactFlow = React.forwardRef(function MockReactFlow(
    props: {
      nodes?: Array<{
        id: string;
        type?: string;
        data?: Record<string, unknown>;
        position?: { x: number; y: number };
      }>;
      edges?: unknown[];
      nodeTypes?: Record<string, React.ComponentType<any>>;
      onNodeClick?: (event: React.MouseEvent, node: any) => void;
      onNodeContextMenu?: (event: React.MouseEvent, node: any) => void;
      onNodeDoubleClick?: (event: React.MouseEvent, node: any) => void;
      onMoveStart?: (event: unknown, viewport: { x: number; y: number; zoom: number }) => void;
      onInit?: () => void;
      children?: React.ReactNode;
    },
    _ref: React.Ref<unknown>,
  ) {
    const { nodes = [], nodeTypes = {}, onNodeClick, onNodeContextMenu, onNodeDoubleClick, onMoveStart, children } = props;

    React.useEffect(() => {
      props.onInit?.();
    }, []);

    // Background pane: panning or wheel-zooming here simulates a user-driven
    // viewport move, forwarding a non-null event to onMoveStart (mirroring real
    // React Flow, which passes null for programmatic moves). It is a sibling of
    // the node elements, so node clicks do not trigger manual-viewport events.
    const emitManualMove = (event: unknown) =>
      onMoveStart?.(event, { x: 0, y: 0, zoom: getZoom() });

    return (
      <div data-testid="mock-react-flow" className="react-flow">
        <div
          data-testid="rf__pane"
          className="react-flow__pane"
          onPointerDown={(e) => emitManualMove(e.nativeEvent)}
          onWheel={(e) => emitManualMove(e.nativeEvent)}
        />
        {props.edges?.map((edge: any) => (
          <div
            key={edge.id}
            data-testid={`rf__edge-${edge.id}`}
            data-source={edge.source}
            data-target={edge.target}
            data-kind={edge.data?.kind}
            data-stroke-dasharray={edge.style?.strokeDasharray ?? ''}
            aria-label={edge.ariaLabel}
          />
        ))}
        {nodes.map((node) => {
          const NodeComponent = nodeTypes[node.type ?? ''];
          return (
            <div
              key={node.id}
              data-testid={`rf__node-${node.id}`}
              className="react-flow__node"
              onClick={(e) => onNodeClick?.(e, node)}
              onContextMenu={(e) => onNodeContextMenu?.(e, node)}
              onDoubleClick={(e) => onNodeDoubleClick?.(e, node)}
            >
              {NodeComponent ? (
                <NodeComponent data={node.data ?? {}} />
              ) : (
                <>
                  <span>{node.data?.label ?? node.data?.task?.description ?? node.id}</span>
                  <span>{node.id}</span>
                </>
              )}
            </div>
          );
        })}
        {children}
      </div>
    );
  });

  const MockReactFlowProvider = ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  );

  return {
    ReactFlow: MockReactFlow,
    ReactFlowProvider: MockReactFlowProvider,
    useReactFlow: () => ({ fitView, setCenter, getZoom, getViewport }),
    __setCenterMock: setCenter,
    __fitViewMock: fitView,
    __getZoomMock: getZoom,
    __getViewportMock: getViewport,
    // Faithful-enough applyNodeChanges: real @xyflow/react records measured
    // dimensions on the node (node.measured) for 'dimensions' changes and flips
    // node.selected for 'select' changes. The TaskDAG relies on measured being
    // preserved across task-delta re-renders, so the mock must mirror that.
    applyNodeChanges: vi.fn((changes: Array<Record<string, any>>, nodes: Array<Record<string, any>>) => {
      const next = nodes.map((node) => ({ ...node }));
      const byId = new Map(next.map((node) => [node.id as string, node]));
      for (const change of changes) {
        const node = byId.get(change.id as string);
        if (!node) continue;
        if (change.type === 'dimensions' && change.dimensions) {
          node.measured = { ...change.dimensions };
        } else if (change.type === 'select') {
          node.selected = change.selected;
        }
      }
      return next;
    }),
    Background: () => null,
    Controls: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  };
}
