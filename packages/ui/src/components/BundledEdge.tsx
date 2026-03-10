/**
 * BundledEdge — Custom edge with offset routing, hover effects, and status-driven styling.
 *
 * When multiple edges share a source or target node, each edge is offset
 * vertically so they fan out instead of stacking on the same path.
 * Uses bezier curves for smooth routing.
 *
 * Visual features:
 * - Stroke pattern varies by source status (dashed=pending, dotted=failed, solid=running/completed)
 * - Hover effect: stroke widens + brightens, label appears
 * - Optional edge label shown on hover for complex graphs
 * - Invisible wider hit area for easier mouse targeting
 */

import { useState, useCallback } from 'react';
import { getBezierPath, BaseEdge, type EdgeProps, type Edge } from '@xyflow/react';

export type BundledEdgeData = {
  /** Vertical pixel offset applied to the source handle position */
  sourceOffset: number;
  /** Vertical pixel offset applied to the target handle position */
  targetOffset: number;
  /** Source task status — drives stroke pattern and color */
  sourceStatus: string;
  /** Target task status */
  targetStatus: string;
  /** Optional label shown on hover */
  label?: string;
  /** Hover stroke color */
  hoverStroke: string;
  /** Hover stroke width */
  hoverWidth: number;
  [key: string]: unknown;
};

type BundledEdge = Edge<BundledEdgeData, 'bundled'>;

export function BundledEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style,
  markerEnd,
  markerStart,
  data,
}: EdgeProps<BundledEdge>) {
  const [hovered, setHovered] = useState(false);

  const srcOffset = data?.sourceOffset ?? 0;
  const tgtOffset = data?.targetOffset ?? 0;

  const [edgePath, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY: sourceY + srcOffset,
    targetX,
    targetY: targetY + tgtOffset,
    sourcePosition,
    targetPosition,
  });

  const onMouseEnter = useCallback(() => setHovered(true), []);
  const onMouseLeave = useCallback(() => setHovered(false), []);

  const baseStroke = style?.stroke as string ?? '#9ca3af';
  const baseWidth = (style?.strokeWidth as number) ?? 2;
  const hoverStroke = data?.hoverStroke ?? baseStroke;
  const hoverWidth = data?.hoverWidth ?? baseWidth + 1;

  const currentStroke = hovered ? hoverStroke : baseStroke;
  const currentWidth = hovered ? hoverWidth : baseWidth;

  const edgeStyle = {
    ...style,
    stroke: currentStroke,
    strokeWidth: currentWidth,
    transition: 'stroke 0.2s ease, stroke-width 0.2s ease, opacity 0.2s ease',
    filter: hovered ? `drop-shadow(0 0 4px ${currentStroke}40)` : undefined,
  };

  const label = data?.label;
  const showLabel = hovered && label;

  return (
    <g
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="bundled-edge-group"
    >
      {/* Invisible wider path for easier hover targeting */}
      <path
        d={edgePath}
        fill="none"
        stroke="transparent"
        strokeWidth={20}
        style={{ cursor: 'pointer' }}
      />

      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        markerStart={markerStart}
        style={edgeStyle}
        labelX={labelX}
        labelY={labelY}
      />

      {/* Hover label */}
      {showLabel && (
        <g transform={`translate(${labelX}, ${labelY})`}>
          <rect
            x={-label.length * 3.5 - 6}
            y={-10}
            width={label.length * 7 + 12}
            height={20}
            rx={4}
            fill="#1f2937"
            fillOpacity={0.9}
            stroke={currentStroke}
            strokeWidth={1}
          />
          <text
            textAnchor="middle"
            dominantBaseline="central"
            fill="#e5e7eb"
            fontSize={11}
            fontFamily="ui-monospace, monospace"
          >
            {label}
          </text>
        </g>
      )}
    </g>
  );
}
