import type { CodexSpendGateStatus } from '@invoker/contracts';
import type { IpcMain } from 'electron';
import { TransportError, TransportErrorCode } from '@invoker/transport';
import type { MessageBus } from '@invoker/transport';
import type { TaskState } from '@invoker/workflow-core';
import type { WorkflowMutationAcceptedResult } from '@invoker/contracts';
import type { WorkflowMutationPriority } from '../workflow-mutation-coordinator.js';
import type { OwnerCapabilityRegistry } from '../owner-capability-registry.js';
import type { ChokeBoundaryMetrics } from '../choke-boundary-metrics.js';

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
  guiMutationHandlers: OwnerCapabilityRegistry;
  chokeMetrics?: ChokeBoundaryMetrics;
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
  context.guiMutationHandlers.register(channel, handler);
  context.ipcMain.handle(channel, async (_event, ...args: unknown[]) => {
    if (context.getOwnerMode()) {
      try {
        const result = await context.guiMutationHandlers.invoke<TResult>(channel, args);
        context.chokeMetrics?.recordRequest('ipc', 'success', { channel });
        return result;
      } catch (err) {
        context.chokeMetrics?.recordRequest('ipc', 'error', { channel });
        throw err;
      }
    }
    const translated = context.translateGuiMutationToHeadless({ channel, args });
    if (!translated) {
      context.chokeMetrics?.recordRequest('ipc', 'no_route', { channel });
      throw new Error(`No owner delegation route is available for ${channel}`);
    }
    try {
      const result = await context.getMessageBus().request<typeof translated.request, TResult>(
        translated.channel,
        translated.request,
      );
      context.chokeMetrics?.recordRequest('ipc', 'delegated', { channel });
      return result;
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
          const result = await context.getMessageBus().request<typeof translated.request, TResult>(
            translated.channel,
            translated.request,
          );
          context.chokeMetrics?.recordRequest('ipc', 'delegated', { channel });
          return result;
        } catch (retryErr) {
          if (retryErr instanceof TransportError && retryErr.code === TransportErrorCode.NO_HANDLER) {
            context.chokeMetrics?.recordRequest('ipc', 'owner_unavailable', { channel });
            throwMutationOwnerUnavailable(context, String(retryErr.message ?? retryErr.code));
          }
          context.chokeMetrics?.recordRequest('ipc', 'error', { channel });
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
        context.chokeMetrics?.recordRequest('ipc', 'owner_unavailable', { channel });
        throwMutationOwnerUnavailable(context, String(err.message ?? err.code));
      }
      context.chokeMetrics?.recordRequest('ipc', 'error', { channel });
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
  codexSpendGate?: CodexSpendGateStatus;
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
  chokeMetrics?: ChokeBoundaryMetrics;
}

export function registerBootstrapStateIpc(context: BootstrapStateIpcContext): void {
  context.ipcMain.on('invoker:get-bootstrap-state-sync', (event, options?: { light?: boolean }) => {
    const startedAtMs = Date.now();
    if (options?.light) {
      const payload = { appStartedAtEpochMs: context.appStartedAtEpochMs };
      const jsonSizeBytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
      context.recordStartupDuration('bootstrap-ipc.serialize-return', startedAtMs, {
        taskCount: 0,
        workflowCount: 0,
        jsonSizeBytes,
        light: true,
      });
      context.chokeMetrics?.recordRequest('ipc', 'success', { channel: 'invoker:get-bootstrap-state-sync' });
      event.returnValue = payload;
      return;
    }
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
    context.chokeMetrics?.recordRequest('ipc', 'success', { channel: 'invoker:get-bootstrap-state-sync' });
    event.returnValue = payload;
  });
}
