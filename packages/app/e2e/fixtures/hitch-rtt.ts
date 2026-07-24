/**
 * Hitch IPC sampling helpers.
 *
 * Sustained stalls are gated by a tight p95 (see
 * docs/architecture/ui-action-responsiveness-invariant.md). CI can still show a
 * single multi-second GC/startup spike while p95 stays ~20–30ms; drop a small
 * number of worst samples only for the max assertion so that spike cannot hide
 * a multi-sample stall (which would move p95).
 */

export const TRANSIENT_WORST_DROPS = 2;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)]!;
}

export type HitchRttWindow = {
  /** Samples used for p95 (after optional leading warm drops). */
  sustained: number[];
  /** Sustained samples with up to N worst RTT values removed (for max). */
  maxWindow: number[];
  droppedWorst: number[];
};

export function hitchRttWindow(
  samples: number[],
  options: { dropFirst?: number; dropWorst?: number } = {},
): HitchRttWindow {
  const dropFirst = options.dropFirst ?? 0;
  const dropWorst = options.dropWorst ?? TRANSIENT_WORST_DROPS;
  const sustained = samples.slice(dropFirst);
  const sortedAsc = [...sustained].sort((a, b) => a - b);
  const dropCount = Math.min(dropWorst, Math.max(0, sortedAsc.length - 1));
  const droppedWorst = sortedAsc.slice(sortedAsc.length - dropCount);
  const maxWindow = sortedAsc.slice(0, sortedAsc.length - dropCount);
  return { sustained, maxWindow, droppedWorst };
}
