import { afterEach, describe, expect, it, vi } from 'vitest';
import { subscribeVisibilityAwarePoll } from '../hooks/visibilityAwarePoll.js';

describe('subscribeVisibilityAwarePoll', () => {
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });
  });

  it('skips interval ticks while document is hidden', () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'hidden',
    });

    const unsubscribe = subscribeVisibilityAwarePoll(poll, 1000);
    expect(poll).not.toHaveBeenCalled();

    vi.advanceTimersByTime(3000);
    expect(poll).not.toHaveBeenCalled();

    unsubscribe();
  });

  it('runs once when becoming visible again', () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    let visibility: DocumentVisibilityState = 'hidden';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });

    const unsubscribe = subscribeVisibilityAwarePoll(poll, 1000, { restoreDelayMs: 50 });
    expect(poll).not.toHaveBeenCalled();

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(poll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(poll).toHaveBeenCalledTimes(1);

    unsubscribe();
  });
});
