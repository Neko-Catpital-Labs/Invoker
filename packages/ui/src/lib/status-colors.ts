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

const NEUTRAL_SURFACE = 'bg-card';
const NEUTRAL_INLINE_BG = '#171717';
const NEUTRAL_INLINE_BORDER = 'rgba(255,255,255,0.08)';

export const STATUS_VISUALS: Record<StatusVisualKey, StatusVisual> = {
  pending: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-muted-foreground',
    dot: 'bg-neutral-400',
    rail: 'bg-neutral-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#a1a1a1' },
    active: false,
    pulse: false,
  },
  running: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-blue-300',
    dot: 'bg-blue-400',
    rail: 'bg-blue-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#93c5fd' },
    active: true,
    pulse: true,
  },
  assigning: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-amber-300',
    dot: 'bg-amber-400',
    rail: 'bg-amber-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#fcd34d' },
    active: true,
    pulse: true,
  },
  running_executing: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    rail: 'bg-sky-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#7dd3fc' },
    active: true,
    pulse: true,
  },
  fixing_with_ai: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-orange-300',
    dot: 'bg-orange-400',
    rail: 'bg-orange-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#fdba74' },
    active: true,
    pulse: true,
  },
  completed: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-emerald-300',
    dot: 'bg-emerald-400',
    rail: 'bg-emerald-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#6ee7b7' },
    active: false,
    pulse: false,
  },
  failed: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-red-300',
    dot: 'bg-red-500',
    rail: 'bg-red-500',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#fca5a5' },
    active: false,
    pulse: false,
  },
  closed: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-zinc-400',
    dot: 'bg-zinc-500',
    rail: 'bg-zinc-500',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#a1a1aa' },
    active: false,
    pulse: false,
  },
  blocked: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-slate-400',
    dot: 'bg-slate-500',
    rail: 'bg-slate-500',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#94a3b8' },
    active: false,
    pulse: false,
  },
  needs_input: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-orange-300',
    dot: 'bg-orange-400',
    rail: 'bg-orange-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#fdba74' },
    active: false,
    pulse: false,
  },
  review_ready: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-sky-300',
    dot: 'bg-sky-400',
    rail: 'bg-sky-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#7dd3fc' },
    active: false,
    pulse: false,
  },
  awaiting_approval: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-purple-300',
    dot: 'bg-purple-400',
    rail: 'bg-purple-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#d8b4fe' },
    active: false,
    pulse: false,
  },
  fix_approval: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-fuchsia-300',
    dot: 'bg-fuchsia-400',
    rail: 'bg-fuchsia-400',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#f0abfc' },
    active: false,
    pulse: false,
  },
  stale: {
    bg: NEUTRAL_SURFACE,
    border: 'border-border',
    text: 'text-neutral-500',
    dot: 'bg-neutral-600',
    rail: 'bg-neutral-600',
    inline: { bg: NEUTRAL_INLINE_BG, border: NEUTRAL_INLINE_BORDER, text: '#737373' },
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
