import { useEffect, useState } from 'react';

/**
 * Subscribe to a shared clock tick.
 *
 * Cosmetic "time-ago" displays in the UI historically owned their own
 * `setInterval` + `setState` pair (one per component), which meant every
 * component ticked independently and paid its own React re-render even
 * when the shared cadence was identical.
 *
 * `useNow(intervalMs, enabled)` returns the current millisecond time and
 * re-renders the calling component on a cadence shared by every subscriber
 * to the same `intervalMs`. Under the hood the module keeps one
 * `setInterval` per interval value; new subscribers attach to the existing
 * timer, and the timer is cleared when the last subscriber unsubscribes.
 *
 * When `enabled` is `false` the caller does not subscribe (no timer is
 * started or ref-counted) but the hook still returns `Date.now()` from the
 * subscribe attempt so callers can render a stable time string.
 */

interface ClockEntry {
  timer: ReturnType<typeof globalThis.setInterval> | null;
  subscribers: Set<(now: number) => void>;
}

const clocks = new Map<number, ClockEntry>();

function subscribe(intervalMs: number, listener: (now: number) => void): () => void {
  let entry = clocks.get(intervalMs);
  if (!entry) {
    entry = { timer: null, subscribers: new Set() };
    clocks.set(intervalMs, entry);
  }
  entry.subscribers.add(listener);
  if (entry.timer === null) {
    entry.timer = globalThis.setInterval(() => {
      const now = Date.now();
      const current = clocks.get(intervalMs);
      if (!current) return;
      for (const fn of current.subscribers) {
        fn(now);
      }
    }, intervalMs);
  }
  return () => {
    const current = clocks.get(intervalMs);
    if (!current) return;
    current.subscribers.delete(listener);
    if (current.subscribers.size === 0) {
      if (current.timer !== null) {
        globalThis.clearInterval(current.timer);
      }
      clocks.delete(intervalMs);
    }
  };
}

export function useNow(intervalMs: number, enabled: boolean = true): number {
  const [now, setNow] = useState<number>(() => Date.now());

  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribe(intervalMs, setNow);
  }, [intervalMs, enabled]);

  return now;
}
