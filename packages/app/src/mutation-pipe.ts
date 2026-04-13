import type { Logger } from '@invoker/contracts';

export type MutationCommandSource = 'gui' | 'headless';
export type MutationCommandStatus = 'queued' | 'running' | 'completed' | 'failed' | 'rejected';
export type MutationCommandScope =
  | { type: 'global' }
  | { type: 'workflow'; workflowId: string };

export interface MutationCommand<TPayload = unknown> {
  id: string;
  source: MutationCommandSource;
  kind: string;
  payload: TPayload;
  createdAt: number;
  scope: MutationCommandScope;
}

export interface MutationCommandState<TResult = unknown> {
  id: string;
  source: MutationCommandSource;
  kind: string;
  scope: MutationCommandScope;
  status: MutationCommandStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: TResult;
}

export interface MutationPipeSnapshot {
  globalRunning: MutationCommandState | null;
  workflowRunning: Record<string, MutationCommandState>;
  globalQueued: MutationCommandState[];
  queuedByWorkflow: Record<string, MutationCommandState[]>;
  recent: MutationCommandState[];
  maxQueued: number;
  maxQueuedPerWorkflow: number;
}

export interface ActiveMutationCommandSnapshot {
  id: string;
  kind: string;
  source: MutationCommandSource;
  workflowId: string | null;
  status: Extract<MutationCommandStatus, 'queued' | 'running'>;
  createdAt: string;
  startedAt: string | null;
}

export interface ActiveMutationPipeSnapshot {
  globalRunning: ActiveMutationCommandSnapshot | null;
  workflowRunning: Record<string, ActiveMutationCommandSnapshot>;
  globalQueued: ActiveMutationCommandSnapshot[];
  queuedByWorkflow: Record<string, ActiveMutationCommandSnapshot[]>;
}

export type ActiveMutationSnapshotGroup =
  | 'globalRunning'
  | 'workflowRunning'
  | 'globalQueued'
  | 'workflowQueued';

export interface FlattenedActiveMutationCommandSnapshot extends ActiveMutationCommandSnapshot {
  group: ActiveMutationSnapshotGroup;
}

export interface MutationPipeOptions<TResult = unknown> {
  logger: Logger;
  dispatch: (command: MutationCommand) => Promise<TResult>;
  maxQueuedCommands?: number;
  maxQueuedCommandsPerWorkflow?: number;
  maxRecentCommands?: number;
  now?: () => number;
}

interface QueuedMutation<TResult> {
  command: MutationCommand;
  state: MutationCommandState<TResult>;
  resolve: (value: TResult) => void;
  reject: (error: unknown) => void;
}

const DEFAULT_MAX_QUEUED_COMMANDS = 100;
const DEFAULT_MAX_QUEUED_COMMANDS_PER_WORKFLOW = 25;
const DEFAULT_MAX_RECENT_COMMANDS = 200;

export class MutationPipe<TResult = unknown> {
  private readonly logger: Logger;
  private readonly dispatch: (command: MutationCommand) => Promise<TResult>;
  private readonly maxQueuedCommands: number;
  private readonly maxQueuedCommandsPerWorkflow: number;
  private readonly maxRecentCommands: number;
  private readonly now: () => number;
  private readonly globalQueue: Array<QueuedMutation<TResult>> = [];
  private readonly workflowQueues = new Map<string, Array<QueuedMutation<TResult>>>();
  private readonly recent: Array<MutationCommandState<TResult>> = [];
  private globalRunning: QueuedMutation<TResult> | null = null;
  private readonly workflowRunning = new Map<string, QueuedMutation<TResult>>();

  constructor(options: MutationPipeOptions<TResult>) {
    this.logger = options.logger;
    this.dispatch = options.dispatch;
    this.maxQueuedCommands = options.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS;
    this.maxQueuedCommandsPerWorkflow =
      options.maxQueuedCommandsPerWorkflow ?? DEFAULT_MAX_QUEUED_COMMANDS_PER_WORKFLOW;
    this.maxRecentCommands = options.maxRecentCommands ?? DEFAULT_MAX_RECENT_COMMANDS;
    this.now = options.now ?? Date.now;
    this.logger.info('mutation.owner_acquired', {
      module: 'mutation-pipe',
      maxQueuedCommands: this.maxQueuedCommands,
      maxQueuedCommandsPerWorkflow: this.maxQueuedCommandsPerWorkflow,
      maxRecentCommands: this.maxRecentCommands,
    });
  }

  async submit(command: MutationCommand): Promise<TResult> {
    if (this.totalQueued() >= this.maxQueuedCommands) {
      const state: MutationCommandState = {
        id: command.id,
        source: command.source,
        kind: command.kind,
        scope: command.scope,
        status: 'rejected',
        createdAt: command.createdAt,
        completedAt: this.now(),
        error: `queue_full:${this.maxQueuedCommands}`,
      };
      this.recordRecent(state);
      this.logger.warn('mutation.rejected', {
        module: 'mutation-pipe',
        commandId: command.id,
        source: command.source,
        kind: command.kind,
        scopeType: command.scope.type,
        workflowId: command.scope.type === 'workflow' ? command.scope.workflowId : undefined,
        queueLength: this.totalQueued(),
        reason: 'queue_full',
        maxQueuedCommands: this.maxQueuedCommands,
      });
      throw new Error(`Mutation queue is full (${this.maxQueuedCommands})`);
    }

    if (command.scope.type === 'workflow') {
      const workflowQueue = this.workflowQueues.get(command.scope.workflowId) ?? [];
      if (workflowQueue.length >= this.maxQueuedCommandsPerWorkflow) {
        const state: MutationCommandState = {
          id: command.id,
          source: command.source,
          kind: command.kind,
          scope: command.scope,
          status: 'rejected',
          createdAt: command.createdAt,
          completedAt: this.now(),
          error: `workflow_queue_full:${this.maxQueuedCommandsPerWorkflow}`,
        };
        this.recordRecent(state);
        this.logger.warn('mutation.rejected', {
          module: 'mutation-pipe',
          commandId: command.id,
          source: command.source,
          kind: command.kind,
          scopeType: command.scope.type,
          workflowId: command.scope.workflowId,
          queueLength: workflowQueue.length,
          reason: 'workflow_queue_full',
          maxQueuedCommandsPerWorkflow: this.maxQueuedCommandsPerWorkflow,
        });
        throw new Error(`Workflow mutation queue is full (${this.maxQueuedCommandsPerWorkflow})`);
      }
    }

    return new Promise<TResult>((resolve, reject) => {
      const state: MutationCommandState<TResult> = {
        id: command.id,
        source: command.source,
        kind: command.kind,
        scope: command.scope,
        status: 'queued',
        createdAt: command.createdAt,
      };
      const entry = { command, state, resolve, reject };
      if (command.scope.type === 'global') {
        this.globalQueue.push(entry);
      } else {
        const workflowQueue = this.workflowQueues.get(command.scope.workflowId) ?? [];
        workflowQueue.push(entry);
        this.workflowQueues.set(command.scope.workflowId, workflowQueue);
      }
      this.logger.info('mutation.enqueued', {
        module: 'mutation-pipe',
        commandId: command.id,
        source: command.source,
        kind: command.kind,
        scopeType: command.scope.type,
        workflowId: command.scope.type === 'workflow' ? command.scope.workflowId : undefined,
        queueLength: this.totalQueued(),
      });
      this.maybeStartWork();
    });
  }

  snapshot(): MutationPipeSnapshot {
    const workflowRunning: Record<string, MutationCommandState> = {};
    for (const [workflowId, entry] of this.workflowRunning) {
      workflowRunning[workflowId] = { ...entry.state };
    }
    const queuedByWorkflow: Record<string, MutationCommandState[]> = {};
    for (const [workflowId, queue] of this.workflowQueues) {
      if (queue.length > 0) {
        queuedByWorkflow[workflowId] = queue.map((entry) => ({ ...entry.state }));
      }
    }
    return {
      globalRunning: this.globalRunning ? { ...this.globalRunning.state } : null,
      workflowRunning,
      globalQueued: this.globalQueue.map((entry) => ({ ...entry.state })),
      queuedByWorkflow,
      recent: this.recent.map((entry) => ({ ...entry })),
      maxQueued: this.maxQueuedCommands,
      maxQueuedPerWorkflow: this.maxQueuedCommandsPerWorkflow,
    };
  }

  dispose(): void {
    this.logger.info('mutation.owner_released', {
      module: 'mutation-pipe',
      queueLength: this.totalQueued(),
      globalRunning: this.globalRunning?.command.id ?? null,
      workflowRunning: Array.from(this.workflowRunning.keys()),
    });
  }

  private maybeStartWork(): void {
    if (this.globalRunning) return;

    if (this.globalQueue.length > 0) {
      if (this.workflowRunning.size === 0) {
        const next = this.globalQueue.shift()!;
        this.globalRunning = next;
        void this.runQueuedMutation(next);
      }
      return;
    }

    for (const [workflowId, queue] of this.workflowQueues) {
      if (queue.length === 0 || this.workflowRunning.has(workflowId)) continue;
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.workflowQueues.delete(workflowId);
      }
      this.workflowRunning.set(workflowId, next);
      void this.runQueuedMutation(next);
    }
  }

  private async runQueuedMutation(next: QueuedMutation<TResult>): Promise<void> {
    next.state.status = 'running';
    next.state.startedAt = this.now();
    this.logger.info('mutation.started', {
      module: 'mutation-pipe',
      commandId: next.command.id,
      source: next.command.source,
      kind: next.command.kind,
      scopeType: next.command.scope.type,
      workflowId: next.command.scope.type === 'workflow' ? next.command.scope.workflowId : undefined,
      queueLength: this.totalQueued(),
      activeWorkflowCount: this.workflowRunning.size,
      enqueueLatencyMs: next.state.startedAt - next.command.createdAt,
    });

    try {
      const result = await this.dispatch(next.command);
      next.state.status = 'completed';
      next.state.completedAt = this.now();
      next.state.result = result;
      this.logger.info('mutation.completed', {
        module: 'mutation-pipe',
        commandId: next.command.id,
        source: next.command.source,
        kind: next.command.kind,
        scopeType: next.command.scope.type,
        workflowId: next.command.scope.type === 'workflow' ? next.command.scope.workflowId : undefined,
        queueLength: this.totalQueued(),
        activeWorkflowCount: this.workflowRunning.size,
        durationMs: next.state.completedAt - (next.state.startedAt ?? next.command.createdAt),
      });
      this.recordRecent(next.state);
      next.resolve(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      next.state.status = 'failed';
      next.state.completedAt = this.now();
      next.state.error = message;
      this.logger.error('mutation.failed', {
        module: 'mutation-pipe',
        commandId: next.command.id,
        source: next.command.source,
        kind: next.command.kind,
        scopeType: next.command.scope.type,
        workflowId: next.command.scope.type === 'workflow' ? next.command.scope.workflowId : undefined,
        queueLength: this.totalQueued(),
        activeWorkflowCount: this.workflowRunning.size,
        durationMs: next.state.completedAt - (next.state.startedAt ?? next.command.createdAt),
        error: message,
      });
      this.recordRecent(next.state);
      next.reject(error);
    } finally {
      if (next.command.scope.type === 'global') {
        this.globalRunning = null;
      } else {
        this.workflowRunning.delete(next.command.scope.workflowId);
      }
      this.maybeStartWork();
    }
  }

  private totalQueued(): number {
    let total = this.globalQueue.length;
    for (const queue of this.workflowQueues.values()) {
      total += queue.length;
    }
    return total;
  }

  private recordRecent(state: MutationCommandState<TResult>): void {
    this.recent.unshift({ ...state });
    if (this.recent.length > this.maxRecentCommands) {
      const dropped = this.recent.pop();
      if (dropped) {
        this.logger.debug('mutation.dropped', {
          module: 'mutation-pipe',
          commandId: dropped.id,
          kind: dropped.kind,
          status: dropped.status,
        });
      }
    }
  }
}

export function createMutationCommand<TPayload>(
  source: MutationCommandSource,
  kind: string,
  payload: TPayload,
  scope: MutationCommandScope = { type: 'global' },
): MutationCommand<TPayload> {
  return {
    id: `mut-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    kind,
    payload,
    createdAt: Date.now(),
    scope,
  };
}

function toIsoTimestamp(value?: number): string | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return new Date(value).toISOString();
}

function normalizeActiveCommand(
  state: MutationCommandState,
): ActiveMutationCommandSnapshot | null {
  if (state.status !== 'queued' && state.status !== 'running') return null;
  return {
    id: state.id,
    kind: state.kind,
    source: state.source,
    workflowId: state.scope.type === 'workflow' ? state.scope.workflowId : null,
    status: state.status,
    createdAt: toIsoTimestamp(state.createdAt) ?? new Date(0).toISOString(),
    startedAt: toIsoTimestamp(state.startedAt),
  };
}

export function emptyActiveMutationSnapshot(): ActiveMutationPipeSnapshot {
  return {
    globalRunning: null,
    workflowRunning: {},
    globalQueued: [],
    queuedByWorkflow: {},
  };
}

export function normalizeActiveMutationSnapshot(
  snapshot: MutationPipeSnapshot,
): ActiveMutationPipeSnapshot {
  const workflowRunning: Record<string, ActiveMutationCommandSnapshot> = {};
  for (const [workflowId, state] of Object.entries(snapshot.workflowRunning)) {
    const normalized = normalizeActiveCommand(state);
    if (normalized) workflowRunning[workflowId] = normalized;
  }

  const queuedByWorkflow: Record<string, ActiveMutationCommandSnapshot[]> = {};
  for (const [workflowId, states] of Object.entries(snapshot.queuedByWorkflow)) {
    const normalized = states
      .map(normalizeActiveCommand)
      .filter((state): state is ActiveMutationCommandSnapshot => state !== null);
    if (normalized.length > 0) {
      queuedByWorkflow[workflowId] = normalized;
    }
  }

  return {
    globalRunning: snapshot.globalRunning ? normalizeActiveCommand(snapshot.globalRunning) : null,
    workflowRunning,
    globalQueued: snapshot.globalQueued
      .map(normalizeActiveCommand)
      .filter((state): state is ActiveMutationCommandSnapshot => state !== null),
    queuedByWorkflow,
  };
}

export function flattenActiveMutationSnapshot(
  snapshot: ActiveMutationPipeSnapshot,
): FlattenedActiveMutationCommandSnapshot[] {
  const flattened: FlattenedActiveMutationCommandSnapshot[] = [];
  if (snapshot.globalRunning) {
    flattened.push({ ...snapshot.globalRunning, group: 'globalRunning' });
  }
  for (const state of Object.values(snapshot.workflowRunning)) {
    flattened.push({ ...state, group: 'workflowRunning' });
  }
  for (const state of snapshot.globalQueued) {
    flattened.push({ ...state, group: 'globalQueued' });
  }
  for (const states of Object.values(snapshot.queuedByWorkflow)) {
    for (const state of states) {
      flattened.push({ ...state, group: 'workflowQueued' });
    }
  }
  return flattened;
}
