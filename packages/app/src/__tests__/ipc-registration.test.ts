import { describe, expect, it, vi } from 'vitest';
import type { IpcMain } from 'electron';
import { TransportError, TransportErrorCode } from '@invoker/transport';
import {
  createGuiMutationRegistrars,
  registerBootstrapStateIpc,
  registerGuiMutationHandler,
  registerWorkflowScopedGuiMutationHandler,
  type GuiMutationRegistrationContext,
  type WorkflowScopedGuiMutationRegistrationContext,
} from '../ipc/ipc-registration.js';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';

type HandleHandler = (_event: unknown, ...args: unknown[]) => Promise<unknown>;
type OnHandler = (event: { returnValue?: unknown }) => void;

function createFakeIpcMain() {
  const handleHandlers = new Map<string, HandleHandler>();
  const onHandlers = new Map<string, OnHandler>();
  const ipcMain = {
    handle: (channel: string, handler: HandleHandler) => {
      handleHandlers.set(channel, handler);
    },
    on: (channel: string, handler: OnHandler) => {
      onHandlers.set(channel, handler);
    },
  } as unknown as IpcMain;
  return { ipcMain, handleHandlers, onHandlers };
}

describe('ipc-registration', () => {
  it('runs mutation handlers locally in owner mode and records the channel', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();
    const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const handler = vi.fn(async (value: unknown) => `owner:${String(value)}`);

    registerGuiMutationHandler(
      {
        ipcMain,
        getOwnerMode: () => true,
        getMessageBus: () => ({ request: vi.fn() }),
        translateGuiMutationToHeadless: vi.fn(),
        guiMutationHandlers,
      },
      'invoker:test',
      handler,
    );

    await expect(handleHandlers.get('invoker:test')?.({}, 'a')).resolves.toBe('owner:a');
    expect(handler).toHaveBeenCalledWith('a');
    expect(guiMutationHandlers.get('invoker:test')).toBe(handler);
  });

  it('delegates mutation handlers through the translated headless route in follower mode', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();
    const request = vi.fn(async (channel: string, payload: unknown) => ({
      channel,
      payload,
    }));

    registerGuiMutationHandler(
      {
        ipcMain,
        getOwnerMode: () => false,
        getMessageBus: () => ({ request }),
        translateGuiMutationToHeadless: ({ channel, args }) => ({
          channel: 'headless.exec',
          request: { source: channel, args },
        }),
      },
      'invoker:approve',
      vi.fn(async () => 'local'),
    );

    await expect(handleHandlers.get('invoker:approve')?.({}, 'task-1')).resolves.toEqual({
      channel: 'headless.exec',
      payload: { source: 'invoker:approve', args: ['task-1'] },
    });
    expect(request).toHaveBeenCalledWith('headless.exec', {
      source: 'invoker:approve',
      args: ['task-1'],
    });
  });

  it('preserves the no-owner error when follower delegation has no handler', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();

    registerGuiMutationHandler(
      {
        ipcMain,
        getOwnerMode: () => false,
        getMessageBus: () => ({
          request: async () => {
            throw new TransportError(TransportErrorCode.NO_HANDLER, 'missing');
          },
        }),
        translateGuiMutationToHeadless: () => ({ channel: 'headless.exec', request: {} }),
      },
      'invoker:cancel-task',
      vi.fn(async () => 'local'),
    );

    await expect(handleHandlers.get('invoker:cancel-task')?.({}, 'task-1')).rejects.toThrow(
      'No mutation owner is available',
    );
  });

  it('refreshes and retries follower delegation when the owner route is gone', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();
    const refreshOwnerRoute = vi.fn(async () => undefined);
    const request = vi
      .fn()
      .mockRejectedValueOnce(new TransportError(TransportErrorCode.NO_HANDLER, 'missing'))
      .mockResolvedValueOnce('delegated');

    registerGuiMutationHandler(
      {
        ipcMain,
        getOwnerMode: () => false,
        getMessageBus: () => ({ request }),
        refreshOwnerRoute,
        translateGuiMutationToHeadless: () => ({
          channel: 'headless.gui-mutation',
          request: { channel: 'invoker:start', args: [] },
        }),
      },
      'invoker:start',
      vi.fn(async () => 'local'),
    );

    await expect(handleHandlers.get('invoker:start')?.({})).resolves.toBe('delegated');
    expect(refreshOwnerRoute).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('registers workflow-scoped handlers with the same dispatcher and enqueue shape', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();
    const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const accepted = {
      ok: true as const,
      accepted: true as const,
      queued: true as const,
      intentId: 42,
      workflowId: 'workflow-for-task-1',
      channel: 'invoker:restart-task',
      label: 'Retry task',
      status: 'queued' as const,
    };
    const submitWorkflowMutation = vi.fn(() => accepted);
    const context: WorkflowScopedGuiMutationRegistrationContext = {
      ipcMain,
      getOwnerMode: () => true,
      getMessageBus: () => ({ request: vi.fn() }),
      translateGuiMutationToHeadless: vi.fn(),
      workflowMutationDispatcher,
      submitWorkflowMutation,
    };
    const handler = vi.fn(async (taskId: unknown) => `done:${String(taskId)}`);

    registerWorkflowScopedGuiMutationHandler(
      context,
      'invoker:restart-task',
      (taskId) => `workflow-for-${String(taskId)}`,
      'high',
      handler,
    );

    await expect(handleHandlers.get('invoker:restart-task')?.({}, 'task-1')).resolves.toBe(accepted);
    expect(handler).not.toHaveBeenCalled();
    expect(submitWorkflowMutation).toHaveBeenCalledWith('workflow-for-task-1', 'high', 'invoker:restart-task', ['task-1']);
    expect(workflowMutationDispatcher.has('invoker:restart-task')).toBe(true);
    await expect(workflowMutationDispatcher.get('invoker:restart-task')?.('task-2')).resolves.toBe('done:task-2');
  });

  it('creates typed registrars that preserve channel registration outputs', async () => {
    const { ipcMain, handleHandlers } = createFakeIpcMain();
    const guiMutationHandlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const workflowMutationDispatcher = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const accepted = {
      ok: true as const,
      accepted: true as const,
      queued: true as const,
      intentId: 9,
      workflowId: 'wf:task-1',
      channel: 'invoker:scoped',
      label: 'Scoped',
      status: 'queued' as const,
    };
    const submitWorkflowMutation = vi.fn(() => accepted);
    const guiContext: GuiMutationRegistrationContext = {
      ipcMain,
      getOwnerMode: () => true,
      getMessageBus: () => ({ request: vi.fn() }),
      translateGuiMutationToHeadless: vi.fn(),
      guiMutationHandlers,
    };
    const workflowContext: WorkflowScopedGuiMutationRegistrationContext = {
      ...guiContext,
      workflowMutationDispatcher,
      submitWorkflowMutation,
    };

    const {
      registerGuiMutationHandler: registerGui,
      registerWorkflowScopedGuiMutationHandler: registerWorkflowScoped,
    } = createGuiMutationRegistrars(guiContext, workflowContext);

    registerGui('invoker:plain', async (value) => `plain:${String(value)}`);
    registerWorkflowScoped(
      'invoker:scoped',
      (taskId) => `wf:${String(taskId)}`,
      'normal',
      async (value) => `scoped:${String(value)}`,
    );

    await expect(handleHandlers.get('invoker:plain')?.({}, 'a')).resolves.toBe('plain:a');
    await expect(handleHandlers.get('invoker:scoped')?.({}, 'task-1')).resolves.toBe(accepted);
    expect([...guiMutationHandlers.keys()]).toEqual(['invoker:plain', 'invoker:scoped']);
    expect([...workflowMutationDispatcher.keys()]).toEqual(['invoker:scoped']);
    expect(submitWorkflowMutation).toHaveBeenCalledWith(
      'wf:task-1',
      'normal',
      'invoker:scoped',
      ['task-1'],
    );
  });

  it('registers bootstrap sync IPC with unchanged payload fields', () => {
    const { ipcMain, onHandlers } = createFakeIpcMain();
    const recordStartupDuration = vi.fn();
    registerBootstrapStateIpc({
      ipcMain,
      getTasks: () => [{ id: 'task-1' } as any],
      getWorkflows: () => [{ id: 'workflow-1' }],
      getInitialWorkflowId: () => 'workflow-1',
      appStartedAtEpochMs: 123,
      getTaskDeltaStreamSequence: () => 7,
      recordStartupDuration,
    });

    const event: { returnValue?: unknown } = {};
    onHandlers.get('invoker:get-bootstrap-state-sync')?.(event);

    expect(event.returnValue).toEqual({
      tasks: [{ id: 'task-1' }],
      workflows: [{ id: 'workflow-1' }],
      initialWorkflowId: 'workflow-1',
      appStartedAtEpochMs: 123,
      streamSequence: 7,
    });
    expect(recordStartupDuration).toHaveBeenCalledWith(
      'bootstrap-ipc.serialize-return',
      expect.any(Number),
      expect.objectContaining({
        taskCount: 1,
        workflowCount: 1,
        jsonSizeBytes: expect.any(Number),
      }),
    );
  });
});
