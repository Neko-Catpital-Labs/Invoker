import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import { BaseExecutor, type BaseEntry } from './base-executor.js';
import { killProcessGroup, cleanElectronEnv, resolveExecutableOnCurrentPath, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { DEFAULT_EXECUTION_AGENT } from './agent.js';
import { traceExecution } from './exec-trace.js';

export interface ScratchExecutorConfig {
  /** Command to invoke the Claude CLI. Defaults to 'claude'. */
  claudeCommand?: string;
  /** Agent registry for pluggable AI agents. When set, overrides claudeCommand. */
  agentRegistry?: import('./agent-registry.js').AgentRegistry;
  /** Heartbeat interval in milliseconds. Default: 30000. */
  heartbeatIntervalMs?: number;
  /** Maximum task duration in milliseconds. Default: 4 hours. */
  maxDurationMs?: number;
}

interface ScratchEntry extends BaseEntry {
  process: ChildProcess | null;
  tmpDir: string;
  agentSessionId?: string;
  agentName?: string;
  rawStdout?: string;
}

function getDisplayOnlyBridgeSpec(
  source: { displayOnlyBridgeText?: string },
): Pick<TerminalSpec, 'displayOnlyBridgeText'> {
  return source.displayOnlyBridgeText === undefined
    ? {}
    : { displayOnlyBridgeText: source.displayOnlyBridgeText };
}

/**
 * Executor for plans declaring `scratch: true`: runs each task in a plain OS
 * temp directory with no git clone/worktree/branch involved. Reuses
 * BaseExecutor's spawn/heartbeat/handleProcessExit machinery — omitting
 * `branch` from handleProcessExit's opts means it performs zero git operations.
 */
export class ScratchExecutor extends BaseExecutor<ScratchEntry> {
  readonly type = 'scratch';

  private readonly claudeCommand: string;
  private readonly agentRegistry?: import('./agent-registry.js').AgentRegistry;
  /**
   * Every temp dir this executor has ever created, independent of `entries`
   * (which drops completed tasks shortly after completion). destroyAll()
   * uses this so completed tasks' temp dirs are still reclaimed on shutdown.
   */
  private readonly allTmpDirs = new Set<string>();

  constructor(config: ScratchExecutorConfig = {}) {
    super(config.heartbeatIntervalMs, config.maxDurationMs);
    this.claudeCommand = config.claudeCommand ?? 'claude';
    this.agentRegistry = config.agentRegistry;
  }

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const handle = this.createHandle(request);
    const executionId = handle.executionId;
    const tmpDir = mkdtempSync(join(tmpdir(), 'invoker-scratch-'));
    this.allTmpDirs.add(tmpDir);
    traceExecution(`[ScratchExecutor] start task=${request.actionId} tmpDir=${tmpDir}`);

    const entry: ScratchEntry = {
      process: null,
      request,
      tmpDir,
      outputListeners: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };
    this.registerEntry(handle, entry);
    handle.workspacePath = tmpDir;

    const { cmd, args, agentSessionId } = this.buildCommandAndArgs(request, {
      claudeCommand: this.claudeCommand,
      agentRegistry: this.agentRegistry,
    });

    const usesAgent = request.actionType === 'ai_task';
    const executionAgent = request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
    const stdinMode = usesAgent && this.agentRegistry
      ? this.agentRegistry.getOrThrow(executionAgent).stdinMode
      : (usesAgent ? 'ignore' : 'pipe');
    const spawnCmd = request.actionType === 'ai_task' ? (resolveExecutableOnCurrentPath(cmd) ?? cmd) : cmd;

    const child = spawn(spawnCmd, args, {
      stdio: [stdinMode, 'pipe', 'pipe'],
      cwd: tmpDir,
      detached: true,
      env: cleanElectronEnv(),
    });

    child.on('error', (err) => {
      traceExecution(`[ScratchExecutor] child process spawn error: ${err.message}`);
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        executionGeneration: request.executionGeneration,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `Failed to spawn command: ${err.message}`,
          agentName: request.actionType === 'ai_task' ? executionAgent : undefined,
        },
      };
      this.emitComplete(executionId, response);
    });

    entry.process = child;
    if (agentSessionId) {
      entry.agentSessionId = agentSessionId;
      handle.agentSessionId = agentSessionId;
    }

    const driver = usesAgent ? this.agentRegistry?.getSessionDriver(executionAgent) : undefined;
    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      if (driver) {
        entry.rawStdout = (entry.rawStdout ?? '') + text;
      } else {
        this.emitOutput(executionId, text);
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', async (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      entry.finalizingAfterClose = true;
      try {
        if (driver && entry.rawStdout) {
          const realId = driver.extractSessionId?.(entry.rawStdout);
          if (realId) entry.agentSessionId = realId;
          const readable = driver.processOutput(entry.agentSessionId ?? '', entry.rawStdout);
          if (readable) this.emitOutput(executionId, readable);
        }
        await this.handleProcessExit(executionId, request, tmpDir, exitCode, {
          signal,
          agentSessionId: entry.agentSessionId,
          agentName: request.actionType === 'ai_task' ? executionAgent : undefined,
        });
      } finally {
        entry.finalizingAfterClose = false;
      }
    });

    this.startHeartbeat(executionId, child);
    return handle;
  }

  sendInput(handle: ExecutorHandle, input: string): void {
    const entry = this.getEntry(handle);
    this.writeProcessInput(entry, input);
  }

  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null {
    const entry = this.getEntry(handle);
    if (!entry) return null;
    const displayBridge = getDisplayOnlyBridgeSpec(handle);
    if (entry.agentSessionId) {
      const agentName = entry.request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(agentName).buildResumeArgs(entry.agentSessionId)
        : { cmd: 'claude', args: ['--resume', entry.agentSessionId, '--dangerously-skip-permissions'] };
      return { command: resume.cmd, args: resume.args, cwd: entry.tmpDir, ...displayBridge };
    }
    return { cwd: entry.tmpDir, ...displayBridge };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    if (meta.workspacePath && !existsSync(meta.workspacePath)) {
      throw new Error(
        `Scratch workspace ${meta.workspacePath} no longer exists for task ${meta.taskId}. ` +
        'It was a temp directory and has since been cleaned up.',
      );
    }
    const displayBridge = getDisplayOnlyBridgeSpec(meta);
    if (meta.agentSessionId) {
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(meta.executionAgent ?? DEFAULT_EXECUTION_AGENT).buildResumeArgs(meta.agentSessionId)
        : { cmd: 'claude', args: ['--resume', meta.agentSessionId, '--dangerously-skip-permissions'] };
      return { command: resume.cmd, args: resume.args, cwd: meta.workspacePath, ...displayBridge };
    }
    return { cwd: meta.workspacePath, ...displayBridge };
  }

  async destroyAll(): Promise<void> {
    const allEntries = Array.from(this.entries.entries());
    const closePromises: Promise<void>[] = [];

    for (const [, entry] of allEntries) {
      if (!entry.completed && entry.process) {
        closePromises.push(
          new Promise<void>((resolve) => {
            entry.process!.on('close', () => resolve());
            killProcessGroup(entry.process!, 'SIGTERM');
            setTimeout(() => {
              if (!entry.completed && entry.process) {
                killProcessGroup(entry.process, 'SIGKILL');
              }
            }, SIGKILL_TIMEOUT_MS);
          }),
        );
      }
    }

    await Promise.all(closePromises);
    this.entries.clear();

    for (const tmpDir of this.allTmpDirs) {
      try {
        rmSync(tmpDir, { recursive: true, force: true });
      } catch (err) {
        traceExecution(`[ScratchExecutor] failed to clean up tmpDir=${tmpDir}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.allTmpDirs.clear();
  }
}
