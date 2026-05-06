import { describe, it, expect, beforeEach, vi } from 'vitest';
import { init } from '../main';

function mockFetchSuccess(message = 'hello') {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve({ message }),
  });
}

function mockFetchError(status = 500, error = 'Internal Server Error') {
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  });
}

function mockFetchNetworkError(msg = 'Network failure') {
  globalThis.fetch = vi.fn().mockRejectedValue(new Error(msg));
}

function getApp() {
  return document.getElementById('app')!;
}

/** Flush microtask queue so `.then()` callbacks run. */
async function flush() {
  await new Promise((r) => setTimeout(r, 0));
}

describe('homepage', () => {
  beforeEach(() => {
    document.body.innerHTML = '<div id="app"></div>';
    vi.restoreAllMocks();
    // Default mock so the top-level init() call from import doesn't throw.
    if (!globalThis.fetch || !(globalThis.fetch as ReturnType<typeof vi.fn>).mock) {
      globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    }
  });

  it('shows loading state immediately after init()', () => {
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));
    init(getApp());
    const app = getApp();
    expect(app.textContent).toBe('Loading…');
    expect(app.dataset.state).toBe('loading');
  });

  it('shows success state after API responds', async () => {
    mockFetchSuccess('hello');
    init(getApp());
    await flush();
    const app = getApp();
    expect(app.textContent).toBe('hello');
    expect(app.dataset.state).toBe('success');
  });

  it('shows error state on HTTP error', async () => {
    mockFetchError(500, 'Internal Server Error');
    init(getApp());
    await flush();
    const app = getApp();
    expect(app.textContent).toBe('Error: Internal Server Error');
    expect(app.dataset.state).toBe('error');
  });

  it('shows error state on network failure', async () => {
    mockFetchNetworkError('Network failure');
    init(getApp());
    await flush();
    const app = getApp();
    expect(app.textContent).toBe('Error: Network failure');
    expect(app.dataset.state).toBe('error');
  });

  it('calls /hello endpoint via fetch', async () => {
    mockFetchSuccess();
    init(getApp());
    await flush();
    expect(globalThis.fetch).toHaveBeenCalledWith('/api/hello');
  });

  it('index.html contains a #app mount point', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../index.html'),
      'utf-8',
    );
    expect(html).toContain('id="app"');
    expect(html).toContain('<script type="module"');
  });

  it('index.html has correct document structure', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const html = fs.readFileSync(
      path.resolve(__dirname, '../../index.html'),
      'utf-8',
    );
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta charset="UTF-8"');
  });
});
