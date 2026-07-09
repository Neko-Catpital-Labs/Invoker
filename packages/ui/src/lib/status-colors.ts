import type { TaskStatus, WorkflowStatus } from '../types.js';

export type StatusVisualKey =
  | TaskStatus
  | WorkflowStatus
  | 'assigning'
  | 'running_executing'
  | 'fix_approval';

export interface StatusInlineColors {
  bg: string;
  border: string;
  text: string;
}

export interface StatusVisual {
  bg: string;
  border: string;
  text: string;
  dot: string;
  rail: string;
  inline: StatusInlineColors;
  active: boolean;
  pulse: boolean;
}

export const STATUS_VISUALS: Record<StatusVisualKey, StatusVisual> = {
  pending: {
    bg: 'bg-slate-800/95',
    border: 'border-white/10',
    text: 'text-slate-100',
    dot: 'bg-slate-400',
    rail: 'bg-slate-400',
    inline: { bg: '#4b5563', border: '#3f4859', text: '#f8fafc' },
    active: false,
    pulse: false,
  },
  running: {
    bg: 'bg-slate-800/95',
    border: 'border-blue-400/25',
    text: 'text-blue-300',
    dot: 'bg-blue-400',
    rail: 'bg-blue-400',
    inline: { bg: '#60a5fa', border: '#2f5f8f', text: '#ecfeff' },
    active: true,
    pulse: true,
  },
  assigning: {
    bg: 'bg-slate-800/95',
    border: 'border-amber-400/30',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    rail: 'bg-amber-400',
    inline: { bg: '#fbbf24', border: '#a16207', text: '#fffbeb' },
    active: true,
    pulse: true,
  },
  running_executing: {
    bg: 'bg-slate-800/95',
    border: 'border-sky-400/30',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    rail: 'bg-sky-400',
    inline: { bg: '#38bdf8', border: '#0369a1', text: '#ecfeff' },
    active: true,
    pulse: true,
  },
  fixing_with_ai: {
    bg: 'bg-orange-900/35',
    border: 'border-orange-400/25',
    text: 'text-orange-100',
    dot: 'bg-orange-400',
    rail: 'bg-orange-400',
    inline: { bg: '#fb923c', border: '#9a4f0a', text: '#ffedd5' },
    active: true,
    pulse: true,
  },
  completed: {
    bg: 'bg-slate-800/95',
    border: 'border-green-500/30',
    text: 'text-green-300',
    dot: 'bg-green-500',
    rail: 'bg-green-500',
    inline: { bg: '#22c55e', border: '#1f7a45', text: '#ecfeff' },
    active: false,
    pulse: false,
  },
  failed: {
    bg: 'bg-red-500/20',
    border: 'border-red-500/55',
    text: 'text-red-300',
    dot: 'bg-red-500',
    rail: 'bg-red-500',
    inline: { bg: '#f87171', border: '#ef4444', text: '#fee2e2' },
    active: false,
    pulse: false,
  },
  closed: {
    bg: 'bg-zinc-500/20',
    border: 'border-zinc-500/55',
    text: 'text-zinc-300',
    dot: 'bg-zinc-500',
    rail: 'bg-zinc-500',
    inline: { bg: '#71717a', border: '#52525b', text: '#f4f4f5' },
    active: false,
    pulse: false,
  },
  blocked: {
    bg: 'bg-slate-800/95',
    border: 'border-slate-500/30',
    text: 'text-slate-300',
    dot: 'bg-slate-500',
    rail: 'bg-slate-500',
    inline: { bg: '#64748b', border: '#475569', text: '#e2e8f0' },
    active: false,
    pulse: false,
  },
  needs_input: {
    bg: 'bg-orange-950/30',
    border: 'border-orange-400/25',
    text: 'text-orange-100',
    dot: 'bg-orange-400',
    rail: 'bg-orange-400',
    inline: { bg: '#fb923c', border: '#9a4f0a', text: '#ffedd5' },
    active: false,
    pulse: false,
  },
  review_ready: {
    bg: 'bg-sky-500/20',
    border: 'border-sky-500/55',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    rail: 'bg-sky-400',
    inline: { bg: '#38bdf8', border: '#0284c7', text: '#e0f2fe' },
    active: false,
    pulse: false,
  },
  awaiting_approval: {
    bg: 'bg-purple-500/20',
    border: 'border-purple-500/55',
    text: 'text-purple-300',
    dot: 'bg-purple-400',
    rail: 'bg-purple-400',
    inline: { bg: '#c084fc', border: '#a855f7', text: '#ede9fe' },
    active: false,
    pulse: false,
  },
  fix_approval: {
    bg: 'bg-fuchsia-500/20',
    border: 'border-fuchsia-500/55',
    text: 'text-fuchsia-300',
    dot: 'bg-fuchsia-500',
    rail: 'bg-fuchsia-500',
    inline: { bg: '#e879f9', border: '#d946ef', text: '#fae8ff' },
    active: false,
    pulse: false,
  },
  stale: {
    bg: 'bg-slate-900/80',
    border: 'border-white/5',
    text: 'text-slate-500',
    dot: 'bg-slate-600',
    rail: 'bg-slate-600',
    inline: { bg: '#475569', border: '#374151', text: '#94a3b8' },
    active: false,
    pulse: false,
  },
};

export const DEFAULT_STATUS_VISUAL = STATUS_VISUALS.pending;

export function getStatusVisual(status: string | undefined): StatusVisual {
  if (!status) return DEFAULT_STATUS_VISUAL;
  return STATUS_VISUALS[status as StatusVisualKey] ?? DEFAULT_STATUS_VISUAL;
}

export function getStatusInlineColors(status: string | undefined): StatusInlineColors {
  return getStatusVisual(status).inline;
}

export function isActiveStatusVisual(status: string | undefined): boolean {
  return getStatusVisual(status).active;
}
