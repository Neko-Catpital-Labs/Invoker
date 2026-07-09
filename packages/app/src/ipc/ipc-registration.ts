import type { IpcMain } from 'electron';
import { TransportError, TransportErrorCode } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationAcceptedResult } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';

export interface GuiMutationPayload {
  channel: string;
  args: unknown[];
}

export type TranslatedGuiMutation =
  | { channel: string; request: unknown }
  | null;

export interface GuiMutationRegistrationContext {
  ipcMain: IpcMain;
  getOwnerMode: () => boolean;
  getMessageBus: () => Pick<MessageBus, 'request'>;
  refreshOwnerRoute?: () => Promise<void>;
  onMutationOwnerUnavailable?: (reason: string) => void;
  translateGuiMutationToHeadless: (payload: GuiMutationPayload) => TranslatedGuiMutation;
  guiMutationHandlers?: Map<string, (...args: unknown[]) => Promise<unknown>>;
}

function throwMutationOwnerUnavailable(
  context: GuiMutationRegistrationContext,
  reason: string,
): never {
  context.onMutationOwnerUnavailable?.(reason);
  throw new Error('No mutation owner is available');
}

export function registerGuiMutationHandler<TResult = unknown>(
  context: GuiMutationRegistrationContext,
  channel: string,
  handler: (...args: unknown[]) => Promise<TResult>,
): void {
  context.guiMutationHandlers?.set(channel, handler as (...args: unknown[]) => Promise<unknown>);
  context.ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    if (context.getOwnerMode()) {
      return handler(...args);
    }
    const translated = context.translateGuiMutationToHeadless({ channel, args });
    if (!translated) {
      throw new Error(`No owner delegation route is available for ${channel}`);
    }
    try {
      return await context.getMessageBus().request<typeof translated.request, TResult>(
        translated.channel,
        translated.request,
      );
    } catch (err) {
      if (
        err instanceof TransportError
        && (
          err.code === TransportErrorCode.NO_HANDLER
          || err.code === TransportErrorCode.DISCONNECTED
        )
        && context.refreshOwnerRoute
      ) {
        await context.refreshOwnerRoute();
        try {
          return await context.getMessageBus().request<typeof translated.request, TResult>(
            translated.channel,
            translated.request,
          );
        } catch (retryErr) {
          if (retryErr instanceof TransportError && retryErr.code === TransportErrorCode.NO_HANDLER) {
            throwMutationOwnerUnavailable(context, String(retryErr.message ?? retryErr.code));
          }
          throw retryErr;
        }
      }
      if (
        err instanceof TransportError
        && (
          err.code === TransportErrorCode.NO_HANDLER
          || err.code === TransportErrorCode.DISCONNECTED
        )
      ) {
        throwMutationOwnerUnavailable(context, String(err.message ?? err.code));
      }
      throw err;
    }
  });
}

export interface WorkflowScopedGuiMutationRegistrationContext extends GuiMutationRegistrationContext {
  workflowMutationDispatcher: Map<string, (...args: unknown[]) => Promise<unknown>>;
  submitWorkflowMutation: (
    workflowId: string | undefined,
    priority: WorkflowMutationPriority,
    channel: string,
    args: unknown[],
  ) => WorkflowMutationAcceptedResult;
}

export function registerWorkflowScopedGuiMutationHandler<TResult = unknown>(
  context: WorkflowScopedGuiMutationRegistrationContext,
  channel: string,
  resolveWorkflowId: (...args: unknown[]) => string | undefined,
  priority: WorkflowMutationPriority,
  handler: (...args: unknown[]) => Promise<TResult>,
): void {
  context.workflowMutationDispatcher.set(channel, (...args: unknown[]) => handler(...args));
  registerGuiMutationHandler(context, channel, async (...args: unknown[]) => {
    const workflowId = resolveWorkflowId(...args);
    return context.submitWorkflowMutation(workflowId, priority, channel, args);
  });
}

export interface GuiMutationRegistrars {
  registerGuiMutationHandler: <TResult = unknown>(
    channel: string,
    handler: (...args: unknown[]) => Promise<TResult>,
  ) => void;
  registerWorkflowScopedGuiMutationHandler: <TResult = unknown>(
    channel: string,
    resolveWorkflowId: (...args: unknown[]) => string | undefined,
    priority: WorkflowMutationPriority,
    handler: (...args: unknown[]) => Promise<TResult>,
  ) => void;
}

export function createGuiMutationRegistrars(
  guiContext: GuiMutationRegistrationContext,
  workflowScopedContext: WorkflowScopedGuiMutationRegistrationContext,
): GuiMutationRegistrars {
  return {
    registerGuiMutationHandler: (channel, handler) => {
      registerGuiMutationHandler(guiContext, channel, handler);
    },
    registerWorkflowScopedGuiMutationHandler: (channel, resolveWorkflowId, priority, handler) => {
      registerWorkflowScopedGuiMutationHandler(
        workflowScopedContext,
        channel,
        resolveWorkflowId,
        priority,
        handler,
      );
    },
  };
}

export interface RuntimeStatusSnapshot {
  ownerMode: boolean;
  readOnly: boolean;
  mode: 'local-owner' | 'daemon-owner' | 'read-only';
}

export interface BootstrapStateIpcContext {
  ipcMain: Pick<IpcMain, 'on'>;
  getTasks: () => TaskState[];
  getWorkflows: () => unknown[];
  getInitialWorkflowId: () => string | null;
  appStartedAtEpochMs: number;
  getTaskDeltaStreamSequence: () => number;
  getRuntimeStatus?: () => RuntimeStatusSnapshot;
  recordStartupDuration: (
    phase: string,
    startedAtMs: number,
    extra?: Record<string, unknown>,
  ) => void;
}

export function registerBootstrapStateIpc(context: BootstrapStateIpcContext): void {
  context.ipcMain.on('invoker:get-bootstrap-state-sync', (event) => {
    const startedAtMs = Date.now();
    const tasks = context.getTasks();
    const workflows = context.getWorkflows();
    const streamSequence = context.getTaskDeltaStreamSequence();
    const runtimeStatus = context.getRuntimeStatus?.();
    const payload = {
      tasks,
      workflows,
      initialWorkflowId: context.getInitialWorkflowId(),
      appStartedAtEpochMs: context.appStartedAtEpochMs,
      streamSequence,
      ...(runtimeStatus ? { runtimeStatus } : {}),
    };
    const jsonSizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    context.recordStartupDuration('bootstrap-ipc.serialize-return', startedAtMs, {
      taskCount: tasks.length,
      workflowCount: workflows.length,
      jsonSizeBytes,
    });
    event.returnValue = payload;
  });
}
