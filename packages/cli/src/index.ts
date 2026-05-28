import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import type { Logger, WorkResponse } from '@invoker/contracts';
import { SQLiteAdapter, SqliteTaskRepository } from '@invoker/data-store';
import {
  IpcBus,
  TransportError,
  TransportErrorCode,
  type MessageBus,
} from '@invoker/transport';
import {
  Orchestrator,
  parsePlanFile,
  type OrchestratorMessageBus,
  type TaskState,
} from '@invoker/workflow-core';

const VERSION = '0.0.2';

type CliOptions = {
  dbDir?: string;
  config?: string;
  json: boolean;
  mode: 'auto' | 'live' | 'standalone';
};

type RunResult = {
  workflowId: string;
  status: 'success' | 'failed';
  completedTasks: number;
  failedTasks: number;
  mode: 'standalone' | 'live';
};

type LiveOwnerInfo = {
  ownerId: string;
  mode: string;
};

type LiveSubmissionResult = {
  workflowId: string;
  tasks: unknown[];
  ownerId?: string;
};

type CliDeps = {
  createMessageBus?: () => Promise<MessageBus> | MessageBus;
};

const silentLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() { return silentLogger; },
};

const noopBus: OrchestratorMessageBus = {
  publish() {},
};

function usage(): string {
  return [
    'Usage:',
    '  invoker-cli run <plan.yaml> [--live|--standalone] [--db-dir <path>] [--config <path>] [--json]',
    '  invoker-cli --help',
    '  invoker-cli --version',
    '',
    'Commands:',
    '  run <plan.yaml>  Submit to a live Invoker UI when available, otherwise run standalone.',
    '',
    'Options:',
    '  --live           Require a running Invoker UI owner and submit over IPC.',
    '  --standalone     Skip IPC and run with an isolated CLI database.',
    '  --db-dir <path>  Runtime database directory. Defaults to ~/.invoker-cli',
    '  --config <path>  Optional config path reserved for CLI runtime configuration.',
    '  --json           Emit a machine-readable result summary.',
    '  --help           Show this help text.',
    '  --version        Show the CLI version.',
  ].join('\n');
}

function parseArgs(argv: string[]): { command?: string; planPath?: string; options: CliOptions } {
  const options: CliOptions = { json: false, mode: 'auto' };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--db-dir') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --db-dir');
      options.dbDir = value;
    } else if (arg === '--config') {
      const value = argv[++i];
      if (!value) throw new Error('Missing value for --config');
      options.config = value;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--live') {
      if (options.mode === 'standalone') throw new Error('Cannot combine --live and --standalone');
      options.mode = 'live';
    } else if (arg === '--standalone') {
      if (options.mode === 'live') throw new Error('Cannot combine --live and --standalone');
      options.mode = 'standalone';
    } else if (arg === '--help' || arg === '-h') {
      positional.push('--help');
    } else if (arg === '--version' || arg === '-v') {
      positional.push('--version');
    } else if (arg.startsWith('--')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  return {
    command: positional[0],
    planPath: positional[1],
    options,
  };
}

function createTraceId(channel: string): string {
  return `${channel}:${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2, 8)}`;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  const TIMEOUT = Symbol('timeout');
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolveTimeout) => {
    timeoutHandle = setTimeout(() => resolveTimeout(TIMEOUT), timeoutMs);
    timeoutHandle.unref?.();
  });
  try {
    const result = await Promise.race([promise, timeout]);
    if (result === TIMEOUT) {
      throw new Error(`Timed out after ${timeoutMs}ms`);
    }
    return result as T;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function discoverLiveOwner(bus: MessageBus, timeoutMs = 1_000): Promise<LiveOwnerInfo | null> {
  try {
    const raw = await withTimeout(
      bus.request('headless.owner-ping', {}),
      timeoutMs,
    );
    if (!raw || typeof raw !== 'object') return null;
    const response = raw as Record<string, unknown>;
    if (response.mode !== 'gui') return null;
    return {
      ownerId: typeof response.ownerId === 'string' ? response.ownerId : '',
      mode: 'gui',
    };
  } catch (err) {
    if (err instanceof TransportError && err.code === TransportErrorCode.NO_HANDLER) {
      return null;
    }
    if (err instanceof Error && err.message.startsWith('Timed out after ')) {
      return null;
    }
    return null;
  }
}

function validateLiveSubmissionResponse(raw: unknown): LiveSubmissionResult {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`Live owner returned invalid headless.run response: expected object, got ${raw === null ? 'null' : typeof raw}`);
  }
  const response = raw as Record<string, unknown>;
  if (typeof response.workflowId !== 'string' || response.workflowId.length === 0) {
    throw new Error('Live owner returned invalid headless.run response: missing workflowId');
  }
  if (!Array.isArray(response.tasks)) {
    throw new Error('Live owner returned invalid headless.run response: missing tasks array');
  }
  return {
    workflowId: response.workflowId,
    tasks: response.tasks,
    ownerId: typeof response.ownerId === 'string' ? response.ownerId : undefined,
  };
}

async function submitPlanToLiveOwner(
  planPath: string,
  bus: MessageBus,
  owner: LiveOwnerInfo,
  timeoutMs = 5_000,
): Promise<LiveSubmissionResult> {
  const absolutePlanPath = resolve(planPath);
  const raw = await withTimeout(
    bus.request('headless.run', {
      planPath: absolutePlanPath,
      traceId: createTraceId('invoker-cli.headless.run'),
    }),
    timeoutMs,
  );
  return {
    ...validateLiveSubmissionResponse(raw),
    ownerId: owner.ownerId,
  };
}

async function runShellCommand(command: string, cwd: string): Promise<{ exitCode: number; output: string }> {
  return new Promise((resolveCommand) => {
    let output = '';
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: process.env,
    });

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stdout.write(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      output += text;
      process.stderr.write(text);
    });
    child.on('error', (err) => {
      output += `${err.message}\n`;
      resolveCommand({ exitCode: 1, output });
    });
    child.on('close', (code) => {
      resolveCommand({ exitCode: code ?? 1, output });
    });
  });
}

function responseForTask(
  task: TaskState,
  status: WorkResponse['status'],
  outputs: WorkResponse['outputs'],
): WorkResponse {
  return {
    requestId: `cli-${task.id}`,
    actionId: task.id,
    attemptId: task.execution.selectedAttemptId,
    executionGeneration: task.execution.generation ?? 0,
    status,
    outputs,
  };
}

async function executeStartedTasks(orchestrator: Orchestrator, tasks: TaskState[], cwd: string): Promise<void> {
  const queue = [...tasks];
  while (queue.length > 0) {
    const task = queue.shift()!;
    if (task.config.isMergeNode) {
      queue.push(...orchestrator.handleWorkerResponse(responseForTask(task, 'completed', {
        exitCode: 0,
        summary: 'No merge action configured for standalone CLI run.',
      })));
      continue;
    }

    if (!task.config.command) {
      queue.push(...orchestrator.handleWorkerResponse(responseForTask(task, 'failed', {
        exitCode: 1,
        error: 'Standalone CLI v1 supports command tasks only.',
      })));
      continue;
    }

    const result = await runShellCommand(task.config.command, cwd);
    queue.push(...orchestrator.handleWorkerResponse(responseForTask(
      task,
      result.exitCode === 0 ? 'completed' : 'failed',
      result.exitCode === 0
        ? { exitCode: 0, summary: result.output }
        : { exitCode: result.exitCode, error: result.output || `Command exited with code ${result.exitCode}` },
    )));
  }
}

async function runPlan(planPath: string, options: CliOptions): Promise<RunResult> {
  const absolutePlanPath = resolve(planPath);
  const dbDir = resolve(options.dbDir ?? join(homedir(), '.invoker-cli'));
  mkdirSync(dbDir, { recursive: true });

  if (options.config) {
    process.env.INVOKER_CONFIG = resolve(options.config);
  }

  const persistence = await SQLiteAdapter.create(join(dbDir, 'invoker.db'), {
    ownerCapability: true,
    outputDir: join(dbDir, 'outputs'),
  });

  try {
    const orchestrator = new Orchestrator({
      persistence,
      taskRepository: new SqliteTaskRepository(persistence),
      messageBus: noopBus,
      logger: silentLogger,
      maxConcurrency: 1,
      launchOutboxMode: 'disabled',
    });
    const plan = await parsePlanFile(absolutePlanPath);
    orchestrator.loadPlan(plan);
    const started = orchestrator.startExecution();
    await executeStartedTasks(orchestrator, started, dirname(absolutePlanPath));

    const workflow = persistence.listWorkflows()[0];
    const tasks = orchestrator.getAllTasks().filter((task) => task.config.workflowId === workflow?.id);
    const failedTasks = tasks.filter((task) => task.status === 'failed').length;
    const completedTasks = tasks.filter((task) => task.status === 'completed').length;
    return {
      workflowId: workflow?.id ?? 'unknown',
      status: failedTasks === 0 ? 'success' : 'failed',
      completedTasks,
      failedTasks,
      mode: 'standalone',
    };
  } finally {
    persistence.close();
  }
}

function printRunResult(result: RunResult, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify({ workflow: { id: result.workflowId, status: result.status }, result })}\n`);
  } else if (result.mode === 'live') {
    process.stdout.write(`Delegated to live owner - workflow: ${result.workflowId}\n`);
  }
}

async function createDefaultMessageBus(): Promise<MessageBus> {
  const bus = new IpcBus(undefined, { allowServe: false });
  await bus.ready();
  return bus;
}

export async function main(argv: string[] = process.argv.slice(2), deps: CliDeps = {}): Promise<number> {
  let bus: MessageBus | undefined;
  try {
    const parsed = parseArgs(argv);
    if (!parsed.command || parsed.command === '--help') {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (parsed.command === '--version') {
      process.stdout.write(`${VERSION}\n`);
      return 0;
    }
    if (parsed.command !== 'run') {
      throw new Error(`Unknown command: ${parsed.command}`);
    }
    if (!parsed.planPath) {
      throw new Error('Missing plan file. Usage: invoker-cli run <plan.yaml>');
    }

    if (parsed.options.mode === 'live' && parsed.options.dbDir) {
      throw new Error('--db-dir cannot be used with --live because the UI owner database is authoritative');
    }

    if (parsed.options.mode !== 'standalone') {
      bus = await (deps.createMessageBus?.() ?? createDefaultMessageBus());
      const owner = await discoverLiveOwner(bus);
      if (owner) {
        if (parsed.options.dbDir) {
          throw new Error('--db-dir cannot be used when a live UI owner accepts the run; use --standalone to force an isolated database');
        }
        const submitted = await submitPlanToLiveOwner(parsed.planPath, bus, owner);
        printRunResult({
          workflowId: submitted.workflowId,
          status: 'success',
          completedTasks: 0,
          failedTasks: 0,
          mode: 'live',
        }, parsed.options.json);
        return 0;
      }
      if (parsed.options.mode === 'live') {
        throw new Error('No running Invoker UI owner is reachable; start the UI or omit --live to run standalone');
      }
    }

    const result = await runPlan(parsed.planPath, parsed.options);
    printRunResult(result, parsed.options.json);
    return result.status === 'success' ? 0 : 1;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  } finally {
    const disconnect = (bus as { disconnect?: () => void } | undefined)?.disconnect;
    if (disconnect) {
      disconnect.call(bus);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  process.exitCode = await main();
}
