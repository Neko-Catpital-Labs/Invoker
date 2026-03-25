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
      onInit?: () => void;
      children?: React.ReactNode;
    },
    _ref: React.Ref<unknown>,
  ) {
    const { nodes = [], nodeTypes = {}, onNodeClick, onNodeContextMenu, onNodeDoubleClick, children } = props;

    React.useEffect(() => {
      props.onInit?.();
    }, []);

    return (
      <div data-testid="mock-react-flow" className="react-flow">
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
    useReactFlow: () => ({ fitView: vi.fn() }),
    applyNodeChanges: vi.fn((changes: unknown[], nodes: unknown[]) => nodes),
    Background: () => null,
    Controls: () => null,
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Handle: () => null,
    Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  };
}
