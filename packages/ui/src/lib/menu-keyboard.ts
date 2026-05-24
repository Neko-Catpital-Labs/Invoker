/**
 * Keyboard navigation helper for menu-like components.
 *
 * Cycles focus through a precomputed list of enabled indices so that the task
 * ContextMenu and the WorkflowContextMenu can share identical ArrowUp/ArrowDown
 * cycling semantics, including wrap-around and skipping disabled items.
 */

export function cycleEnabledIndex(
  enabledIndices: readonly number[],
  current: number,
  direction: 1 | -1,
): number {
  if (enabledIndices.length === 0) return current;
  const currentPos = enabledIndices.indexOf(current);
  const baseIndex = currentPos === -1 ? (direction === 1 ? -1 : 0) : currentPos;
  const nextPos = (baseIndex + direction + enabledIndices.length) % enabledIndices.length;
  return enabledIndices[nextPos];
}
