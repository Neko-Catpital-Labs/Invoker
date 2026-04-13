import type { Logger } from '@invoker/contracts';

export type MutationCommandSource = 'gui' | 'headless';
export type MutationCommandStatus = 'queued' | 'running' | 'completed' | 'failed' | 'rejected';

export interface MutationCommand<TPayload = unknown> {
  id: string;
  source: MutationCommandSource;
  kind: string;
  payload: TPayload;
  createdAt: number;
}

export interface MutationCommandState<TResult = unknown> {
  id: string;
  source: MutationCommandSource;
  kind: string;
  status: MutationCommandStatus;
  createdAt: number;
  startedAt?: number;
  completedAt?: number;
  error?: string;
  result?: TResult;
}

export interface MutationPipeSnapshot {
  running: MutationCommandState | null;
  queued: MutationCommandState[];
  recent: MutationCommandState[];
  maxQueued: number;
}

export interface MutationPipeOptions<TResult = unknown> {
  logger: Logger;
  dispatch: (command: MutationCommand) => Promise<TResult>;
  maxQueuedCommands?: number;
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
const DEFAULT_MAX_RECENT_COMMANDS = 200;

export class MutationPipe<TResult = unknown> {
  private readonly logger: Logger;
  private readonly dispatch: (command: MutationCommand) => Promise<TResult>;
  private readonly maxQueuedCommands: number;
  private readonly maxRecentCommands: number;
  private readonly now: () => number;
  private readonly queue: Array<QueuedMutation<TResult>> = [];
  private readonly recent: Array<MutationCommandState<TResult>> = [];
  private running: QueuedMutation<TResult> | null = null;
  private draining = false;

  constructor(options: MutationPipeOptions<TResult>) {
    this.logger = options.logger;
    this.dispatch = options.dispatch;
    this.maxQueuedCommands = options.maxQueuedCommands ?? DEFAULT_MAX_QUEUED_COMMANDS;
    this.maxRecentCommands = options.maxRecentCommands ?? DEFAULT_MAX_RECENT_COMMANDS;
    this.now = options.now ?? Date.now;
    this.logger.info('mutation.owner_acquired', {
      module: 'mutation-pipe',
      maxQueuedCommands: this.maxQueuedCommands,
      maxRecentCommands: this.maxRecentCommands,
    });
  }

  async submit(command: MutationCommand): Promise<TResult> {
    if (this.queue.length >= this.maxQueuedCommands) {
      const state: MutationCommandState = {
        id: command.id,
        source: command.source,
        kind: command.kind,
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
        queueLength: this.queue.length,
        reason: 'queue_full',
        maxQueuedCommands: this.maxQueuedCommands,
      });
      throw new Error(`Mutation queue is full (${this.maxQueuedCommands})`);
    }

    return new Promise<TResult>((resolve, reject) => {
      const state: MutationCommandState<TResult> = {
        id: command.id,
        source: command.source,
        kind: command.kind,
        status: 'queued',
        createdAt: command.createdAt,
      };
      this.queue.push({ command, state, resolve, reject });
      this.logger.info('mutation.enqueued', {
        module: 'mutation-pipe',
        commandId: command.id,
        source: command.source,
        kind: command.kind,
        queueLength: this.queue.length,
      });
      void this.drain();
    });
  }

  snapshot(): MutationPipeSnapshot {
    return {
      running: this.running ? { ...this.running.state } : null,
      queued: this.queue.map((entry) => ({ ...entry.state })),
      recent: this.recent.map((entry) => ({ ...entry })),
      maxQueued: this.maxQueuedCommands,
    };
  }

  dispose(): void {
    this.logger.info('mutation.owner_released', {
      module: 'mutation-pipe',
      queueLength: this.queue.length,
      running: this.running?.command.id ?? null,
    });
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue.shift()!;
        this.running = next;
        next.state.status = 'running';
        next.state.startedAt = this.now();
        this.logger.info('mutation.started', {
          module: 'mutation-pipe',
          commandId: next.command.id,
          source: next.command.source,
          kind: next.command.kind,
          queueLength: this.queue.length,
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
            queueLength: this.queue.length,
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
            queueLength: this.queue.length,
            durationMs: next.state.completedAt - (next.state.startedAt ?? next.command.createdAt),
            error: message,
          });
          this.recordRecent(next.state);
          next.reject(error);
        } finally {
          this.running = null;
        }
      }
    } finally {
      this.draining = false;
    }
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
): MutationCommand<TPayload> {
  return {
    id: `mut-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    source,
    kind,
    payload,
    createdAt: Date.now(),
  };
}
