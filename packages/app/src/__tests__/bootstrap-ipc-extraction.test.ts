import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { registerGuiBootstrapLifecycle } from '../bootstrap/app-bootstrap.js';
import { createIpcRegistration, type IpcMainLike } from '../ipc/ipc-registration.js';

describe('bootstrap extraction', () => {
  it('preserves GUI startup lifecycle ordering', async () => {
    const calls: string[] = [];
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const app = {
      whenReady: () => {
        calls.push('app.whenReady');
        return Promise.resolve();
      },
      on: (channel: 'activate' | 'window-all-closed' | 'before-quit', listener: (...args: unknown[]) => unknown) => {
        calls.push(`app.on:${channel}`);
        listeners.set(channel, listener);
      },
    };

    registerGuiBootstrapLifecycle({
      app,
      BrowserWindow: { getAllWindows: () => [] },
      onReady: async () => {
        calls.push('onReady');
      },
      onReadyError: () => {
        calls.push('onReadyError');
      },
      createWindow: () => {
        calls.push('createWindow');
      },
      onWindowAllClosed: () => {
        calls.push('windowAllClosed');
      },
      onBeforeQuit: () => {
        calls.push('beforeQuit');
      },
    });

    await Promise.resolve();
    listeners.get('activate')?.();
    listeners.get('window-all-closed')?.();
    listeners.get('before-quit')?.({ preventDefault: () => undefined });

    expect(calls).toEqual([
      'app.whenReady',
      'app.on:activate',
      'app.on:window-all-closed',
      'app.on:before-quit',
      'onReady',
      'createWindow',
      'windowAllClosed',
      'beforeQuit',
    ]);
  });
});

describe('IPC registration extraction', () => {
  it('preserves owner execution and follower delegation outputs', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown>();
    const ipcMain: IpcMainLike = {
      handle: (channel, listener) => {
        handlers.set(channel, listener);
      },
    };
    const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const busRequests: Array<{ channel: string; request: unknown }> = [];
    let ownerMode = true;

    const registration = createIpcRegistration<'normal'>({
      ipcMain,
      guiMutationHandlers,
      workflowMutationDispatcher,
      isOwnerMode: () => ownerMode,
      getMessageBus: () => ({
        request: async (_channel, request) => {
          busRequests.push({ channel: _channel, request });
          return { delegated: true, request };
        },
      }),
      translateGuiMutationToHeadless: ({ channel, args }) => ({
        channel: 'headless.exec',
        request: { args: [channel, ...args] },
      }),
      isMissingOwnerError: () => false,
      runWorkflowMutation: async (_workflowId, _priority, _channel, _args, op) => op(),
    });

    registration.registerGuiMutationHandler('invoker:test', async (value) => ({ owner: true, value }));

    await expect(handlers.get('invoker:test')?.({}, 'task-1')).resolves.toEqual({
      owner: true,
      value: 'task-1',
    });

    ownerMode = false;

    await expect(handlers.get('invoker:test')?.({}, 'task-2')).resolves.toEqual({
      delegated: true,
      request: { args: ['invoker:test', 'task-2'] },
    });
    expect(busRequests).toEqual([
      { channel: 'headless.exec', request: { args: ['invoker:test', 'task-2'] } },
    ]);
    expect(guiMutationHandlers.has('invoker:test')).toBe(true);
    expect(registration.registeredChannels).toEqual(['invoker:test']);
  });

  it('preserves workflow-scoped registration outputs', async () => {
    const handlers = new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown> | unknown>();
    const calls: Array<{ workflowId: string | undefined; priority: string; channel: string; args: unknown[] }> = [];
    const registration = createIpcRegistration<'high'>({
      ipcMain: {
        handle: (channel, listener) => {
          handlers.set(channel, listener);
        },
      },
      guiMutationHandlers: new Map(),
      workflowMutationDispatcher: new Map(),
      isOwnerMode: () => true,
      getMessageBus: () => ({ request: async () => undefined }),
      translateGuiMutationToHeadless: () => null,
      isMissingOwnerError: () => false,
      runWorkflowMutation: async (workflowId, priority, channel, args, op) => {
        calls.push({ workflowId, priority, channel, args });
        return op();
      },
    });

    registration.registerWorkflowScopedGuiMutationHandler(
      'invoker:workflow-test',
      (workflowId) => String(workflowId),
      'high',
      async (workflowId, taskId) => ({ workflowId, taskId }),
    );

    await expect(handlers.get('invoker:workflow-test')?.({}, 'wf-1', 'task-1')).resolves.toEqual({
      workflowId: 'wf-1',
      taskId: 'task-1',
    });
    expect(calls).toEqual([
      {
        workflowId: 'wf-1',
        priority: 'high',
        channel: 'invoker:workflow-test',
        args: ['wf-1', 'task-1'],
      },
    ]);
    expect(registration.registeredChannels).toEqual(['invoker:workflow-test']);
  });
});

describe('main composition root extraction', () => {
  it('delegates GUI bootstrap and IPC registration through extracted modules', () => {
    const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

    expect(mainSource).toContain("from './bootstrap/app-bootstrap.js'");
    expect(mainSource).toContain("from './ipc/ipc-registration.js'");
    expect(mainSource).toContain('registerGuiBootstrapLifecycle({');
    expect(mainSource).toContain('createIpcRegistration<WorkflowMutationPriority>({');
  });
});
