import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { startServer } from '../server.js';

/** Close a server, ignoring errors if already closed. */
function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

describe('dormant bridge guard — startServer', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it('does not invoke the hook when enableDormantBridge is omitted', async () => {
    const hook = vi.fn();
    server = await startServer({ port: 0, host: '127.0.0.1', dormantBridgeHook: hook });

    expect(hook).not.toHaveBeenCalled();
  });

  it('does not invoke the hook when enableDormantBridge is false', async () => {
    const hook = vi.fn();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      enableDormantBridge: false,
      dormantBridgeHook: hook,
    });

    expect(hook).not.toHaveBeenCalled();
  });

  it('does not throw when enableDormantBridge is true but no hook is provided', async () => {
    server = await startServer({ port: 0, host: '127.0.0.1', enableDormantBridge: true });

    const addr = server.address();
    expect(addr).not.toBeNull();
  });

  it('invokes the hook with the server when explicitly opted in', async () => {
    const hook = vi.fn();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      enableDormantBridge: true,
      dormantBridgeHook: hook,
    });

    expect(hook).toHaveBeenCalledTimes(1);
    expect(hook).toHaveBeenCalledWith(server);
  });

  it('does not alter active /health behavior when bridge is enabled', async () => {
    const hook = vi.fn();
    server = await startServer({
      port: 0,
      host: '127.0.0.1',
      enableDormantBridge: true,
      dormantBridgeHook: hook,
    });

    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('not listening');

    const res = await fetch(`http://127.0.0.1:${addr.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
  });
});
