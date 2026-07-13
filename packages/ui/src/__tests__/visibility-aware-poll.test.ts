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

  it('defers the initial poll by initialDelayMs so the mount/click can paint', () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    const unsubscribe = subscribeVisibilityAwarePoll(poll, 1000, { initialDelayMs: 200 });
    expect(poll).not.toHaveBeenCalled();

    vi.advanceTimersByTime(199);
    expect(poll).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(poll).toHaveBeenCalledTimes(1);

    unsubscribe();
  });

  it('cancels a pending initial poll on unsubscribe', () => {
    vi.useFakeTimers();
    const poll = vi.fn();
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => 'visible',
    });

    const unsubscribe = subscribeVisibilityAwarePoll(poll, 1000, { initialDelayMs: 200 });
    unsubscribe();
    vi.advanceTimersByTime(500);
    expect(poll).not.toHaveBeenCalled();
  });
});
