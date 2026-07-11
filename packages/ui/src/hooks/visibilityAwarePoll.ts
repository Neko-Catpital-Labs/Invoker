/**
 * Shared visibility-aware polling for renderer → main status IPC.
 * Skips ticks while document is hidden (Cmd-Tab away) and refreshes once on
 * restore so Chromium timer catch-up cannot herd sync SQLite work onto main.
 */
export function subscribeVisibilityAwarePoll(
  poll: () => void | Promise<void>,
  pollMs: number,
  options?: {
    /** Delay before the visibility-restore refresh (ms). Use to stagger herds. */
    restoreDelayMs?: number;
    /** Delay before the first poll on subscribe (ms). Heavy readers set this so a click/nav paints before the sync main-process query runs. Default 0 = immediate. */
    initialDelayMs?: number;
  },
): () => void {
  let cancelled = false;
  let restoreTimer: number | undefined;
  let initialTimer: number | undefined;

  const runIfVisible = (): void => {
    if (cancelled) return;
    if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
    void poll();
  };

  const onVisibilityChange = (): void => {
    if (cancelled) return;
    if (typeof document === 'undefined') return;
    if (document.visibilityState !== 'visible') {
      if (restoreTimer !== undefined) {
        window.clearTimeout(restoreTimer);
        restoreTimer = undefined;
      }
      return;
    }
    const delay = options?.restoreDelayMs ?? 0;
    if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    restoreTimer = window.setTimeout(() => {
      restoreTimer = undefined;
      runIfVisible();
    }, delay);
  };

  const initialDelay = options?.initialDelayMs ?? 0;
  if (initialDelay > 0) {
    initialTimer = window.setTimeout(() => {
      initialTimer = undefined;
      runIfVisible();
    }, initialDelay);
  } else {
    runIfVisible();
  }
  const interval = window.setInterval(runIfVisible, pollMs);
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
  }

  return () => {
    cancelled = true;
    window.clearInterval(interval);
    if (restoreTimer !== undefined) window.clearTimeout(restoreTimer);
    if (initialTimer !== undefined) window.clearTimeout(initialTimer);
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange);
    }
  };
}
