import type {
  Logger,
  OpenTerminalResponse,
  TerminalSessionDescriptor,
} from '@invoker/contracts';
import type { SQLiteAdapter } from '@invoker/data-store';
import type { AgentRegistry, ExecutorRegistry } from '@invoker/execution-engine';
import type { EmbeddedTerminalManager } from './embedded-terminal-manager.js';
import type { TaskHandleMap } from './execution/task-runner-wiring.js';
import {
  openEmbeddedTerminalForTask,
  type OpenTerminalPersistence,
} from './open-terminal-for-task.js';
import {
  closeTaskTerminalSession,
  listTaskTerminalSessions,
  resizeTaskTerminalSession,
  writeTaskTerminalSession,
} from './terminal-session-ipc.js';
import type {
  TerminalUiPerfCounters,
  TerminalUiPerfReporter,
  TerminalUiPerfSink,
} from './terminal-ui-perf.js';

type TaskTerminalPersistence = OpenTerminalPersistence &
  Pick<SQLiteAdapter, 'listTerminalSessions' | 'deleteTerminalSession'>;

export interface TaskTerminalMutationResult {
  ok: boolean;
  reason?: string;
}

export interface TaskTerminalAdapter {
  open(taskId: string): OpenTerminalResponse | Promise<OpenTerminalResponse>;
  list(): TerminalSessionDescriptor[] | Promise<TerminalSessionDescriptor[]>;
  write(
    sessionId: string,
    data: string,
  ): TaskTerminalMutationResult | Promise<TaskTerminalMutationResult>;
  resize(
    sessionId: string,
    cols: number,
    rows: number,
  ): TaskTerminalMutationResult | Promise<TaskTerminalMutationResult>;
  close(sessionId: string): TaskTerminalMutationResult | Promise<TaskTerminalMutationResult>;
}

export interface CreateTaskTerminalAdapterDeps {
  persistence?: TaskTerminalPersistence;
  getPersistence?: () => TaskTerminalPersistence | undefined;
  executorRegistry?: ExecutorRegistry;
  getExecutorRegistry?: () => ExecutorRegistry | undefined;
  executionAgentRegistry?: AgentRegistry;
  repoRoot: string;
  taskHandles: Pick<TaskHandleMap, 'get'>;
  embeddedTerminalManager: Pick<
    EmbeddedTerminalManager,
    'openOrReuse' | 'list' | 'get' | 'write' | 'resize' | 'close'
  >;
  uiPerfStats: TerminalUiPerfCounters;
  terminalUiPerf: TerminalUiPerfReporter;
  terminalUiPerfSink: TerminalUiPerfSink;
  logger?: Logger;
}

export function createTaskTerminalAdapter(
  deps: CreateTaskTerminalAdapterDeps,
): TaskTerminalAdapter {
  const getPersistence = (): TaskTerminalPersistence | undefined =>
    deps.getPersistence?.() ?? deps.persistence;
  const getExecutorRegistry = (): ExecutorRegistry | undefined =>
    deps.getExecutorRegistry?.() ?? deps.executorRegistry;

  return {
    open(taskId: string) {
      const executorRegistry = getExecutorRegistry();
      if (!executorRegistry) {
        return {
          opened: false,
          reason: `Task "${taskId}" terminal metadata is unavailable.`,
        };
      }
      return openEmbeddedTerminalForTask({
        taskId,
        persistence: getPersistence(),
        executorRegistry,
        executionAgentRegistry: deps.executionAgentRegistry,
        repoRoot: deps.repoRoot,
        taskHandles: deps.taskHandles,
        embeddedTerminalManager: deps.embeddedTerminalManager,
        logger: deps.logger,
      });
    },
    list() {
      const persistence = getPersistence();
      if (!persistence) {
        return deps.embeddedTerminalManager
          .list()
          .filter((session) => session.kind !== 'planning');
      }
      return listTaskTerminalSessions({
        embeddedTerminalManager: deps.embeddedTerminalManager,
        persistence,
      });
    },
    write(sessionId: string, data: string) {
      return writeTaskTerminalSession(
        {
          embeddedTerminalManager: deps.embeddedTerminalManager,
          uiPerfStats: deps.uiPerfStats,
          terminalUiPerf: deps.terminalUiPerf,
          terminalUiPerfSink: deps.terminalUiPerfSink,
        },
        sessionId,
        data,
      );
    },
    resize(sessionId: string, cols: number, rows: number) {
      return resizeTaskTerminalSession(
        {
          embeddedTerminalManager: deps.embeddedTerminalManager,
          uiPerfStats: deps.uiPerfStats,
          terminalUiPerf: deps.terminalUiPerf,
          terminalUiPerfSink: deps.terminalUiPerfSink,
        },
        sessionId,
        cols,
        rows,
      );
    },
    close(sessionId: string) {
      return closeTaskTerminalSession(
        {
          embeddedTerminalManager: deps.embeddedTerminalManager,
          persistence: getPersistence(),
        },
        sessionId,
      );
    },
  };
}
