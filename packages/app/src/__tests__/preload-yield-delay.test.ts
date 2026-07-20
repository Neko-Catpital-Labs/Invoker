import { describe, expect, it, vi, afterEach } from 'vitest';

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: vi.fn(),
  },
  ipcRenderer: {
    sendSync: vi.fn(() => undefined),
    invoke: vi.fn(() => Promise.resolve()),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
}));

import { yieldToPendingRendererInput } from '../preload.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('yieldToPendingRendererInput', () => {
  it('waits for the requested delay before resolving', async () => {
    vi.useFakeTimers();

    let resolved = false;
    const pending = yieldToPendingRendererInput(50).then(() => {
      resolved = true;
    });

    await vi.advanceTimersByTimeAsync(49);
    expect(resolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(resolved).toBe(true);
  });
});
