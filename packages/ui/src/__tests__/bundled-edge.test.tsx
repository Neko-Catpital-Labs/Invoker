import { fireEvent, render } from '@testing-library/react';
import { Position } from '@xyflow/react';
import { describe, expect, it } from 'vitest';

import { BundledEdge, type BundledEdgeData } from '../components/BundledEdge.js';

function renderEdge(
  data?: Partial<BundledEdgeData>,
  selected = false,
  endpoints: { source?: string; target?: string } = {},
) {
  return render(
    <svg>
      <BundledEdge
        id="edge-a-b"
        source={endpoints.source ?? 'a'}
        target={endpoints.target ?? 'b'}
        sourceX={10}
        sourceY={20}
        targetX={110}
        targetY={70}
        sourcePosition={Position.Right}
        targetPosition={Position.Left}
        sourceHandleId={null}
        targetHandleId={null}
        markerEnd="url(#arrow)"
        markerStart={undefined}
        selected={selected}
        style={{ stroke: '#64748b', strokeWidth: 2, opacity: data?.external ? 0.24 : 1 }}
        data={{
          sourceOffset: 0,
          targetOffset: 0,
          sourceStatus: 'completed',
          targetStatus: 'pending',
          label: 'a -> b',
          hoverStroke: '#0f172a',
          hoverWidth: 4,
          ...data,
        }}
      />
    </svg>,
  );
}

function visibleEdgePath(container: HTMLElement): SVGPathElement {
  const paths = [...container.querySelectorAll('path')] as SVGPathElement[];
  const path = paths.find((candidate) => candidate.getAttribute('stroke') !== 'transparent');
  if (!path) throw new Error('visible edge path not found');
  return path;
}

describe('BundledEdge', () => {
  it('renders routed orthogonal paths when routePoints are present', () => {
    const { container } = renderEdge({
      routePoints: [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 70 },
        { x: 110, y: 70 },
      ],
    });

    expect(visibleEdgePath(container).getAttribute('d')).toBe('M 10 20 L 40 20 L 40 70 L 110 70');
  });

  it('falls back to a Bezier path without routePoints', () => {
    const { container } = renderEdge();

    expect(visibleEdgePath(container).getAttribute('d')).toContain('C');
  });

  it('dims external edges by default and strengthens them on hover', () => {
    const { container } = renderEdge({ external: true });

    expect(visibleEdgePath(container).getAttribute('style')).toContain('opacity: 0.24');

    fireEvent.mouseEnter(container.querySelector('.bundled-edge-group')!);

    expect(visibleEdgePath(container).getAttribute('style')).toContain('opacity: 0.86');
  });

  it('strengthens external edges when selection touches them', () => {
    const { container } = renderEdge({ external: true, selectionActive: true });

    expect(visibleEdgePath(container).getAttribute('style')).toContain('opacity: 0.86');
  });

  it('renders the supplied scoped-task edge label without falling back to workflow-prefixed ids', () => {
    const { container, getByText } = renderEdge(
      { label: 'setup-task → render-task' },
      false,
      { source: 'wf-alpha/setup-task', target: 'wf-alpha/render-task' },
    );

    fireEvent.mouseEnter(container.querySelector('.bundled-edge-group')!);

    expect(getByText('setup-task → render-task')).toBeInTheDocument();
    expect(container.textContent).not.toContain('wf-alpha');
  });
});
