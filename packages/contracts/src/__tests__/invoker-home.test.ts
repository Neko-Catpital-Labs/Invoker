import { describe, expect, it } from 'vitest';
import { join } from 'node:path';

import { resolveInvokerHomeRoot, resolveInvokerIpcSocketPath } from '../invoker-home.js';

describe('Invoker home resolution', () => {
  it('uses INVOKER_DB_DIR as the home root', () => {
    expect(resolveInvokerHomeRoot({ INVOKER_DB_DIR: '/tmp/invoker-a' }, '/home/user')).toBe('/tmp/invoker-a');
  });

  it('uses the live home root by default', () => {
    expect(resolveInvokerHomeRoot({}, '/home/user')).toBe(join('/home/user', '.invoker'));
  });

  it('uses an isolated test home root in test mode', () => {
    expect(resolveInvokerHomeRoot({ NODE_ENV: 'test' }, '/home/user')).toBe(join('/home/user', '.invoker', 'test'));
  });

  it('places the default IPC socket under the resolved home root', () => {
    expect(resolveInvokerIpcSocketPath({ INVOKER_DB_DIR: '/tmp/invoker-b' }, '/home/user')).toBe(
      join('/tmp/invoker-b', 'ipc-transport.sock'),
    );
  });

  it('keeps INVOKER_IPC_SOCKET as an explicit override', () => {
    expect(resolveInvokerIpcSocketPath({
      INVOKER_DB_DIR: '/tmp/invoker-c',
      INVOKER_IPC_SOCKET: '/tmp/custom.sock',
    }, '/home/user')).toBe('/tmp/custom.sock');
  });
});
