import { spawn, type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import type {
  Logger,
  OpenPlanningTerminalRequest,
  OpenPlanningTerminalResult,
  PlanningTerminalCloseRequest,
  PlanningTerminalCloseResult,
  PlanningTerminalClosedEvent,
  PlanningTerminalOutputEvent,
  PlanningTerminalResizeRequest,
  PlanningTerminalSession,
  PlanningTerminalWriteRequest,
  PlanningTerminalWriteResult,
} from '@invoker/contracts';

type SpawnFn = typeof spawn;

interface ManagedPlanningTerminal {
  child: ChildProcess;
  session: PlanningTerminalSession;
  output: string;
  closing: boolean;
}

export interface EmbeddedTerminalManagerOptions {
  repoRoot: string;
  logger?: Logger;
  spawn?: SpawnFn;
  shell?: string;
  env?: NodeJS.ProcessEnv;
  maxOutputBufferBytes?: number;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_MAX_OUTPUT_BUFFER_BYTES = 256 * 1024;

function normalizePlanningSessionId(value: unknown): string {
  const planningSessionId = typeof value === 'string' ? value.trim() : '';
  if (!planningSessionId) {
    throw new Error('planningSessionId is required.');
  }
  return planningSessionId;
}

function normalizeDimension(name: 'cols' | 'rows', value: unknown, fallback?: number): number {
  if (value == null && fallback != null) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return n;
}

function buildPlanningTerminalId(planningSessionId: string): string {
  return `planning:${planningSessionId}`;
}

function resolveInteractiveShell(shellOverride?: string): { command: string; args: string[] } {
  if (process.platform === 'win32') {
    return { command: shellOverride || process.env.COMSPEC || 'cmd.exe', args: [] };
  }

  const command = shellOverride || process.env.SHELL || '/bin/bash';
  const base = path.basename(command);
  if (base === 'bash' || base === 'zsh' || base === 'fish' || base === 'sh') {
    return { command, args: ['-i'] };
  }
  return { command, args: [] };
}

function trimOutputBuffer(output: string, maxBytes: number): string {
  if (Buffer.byteLength(output, 'utf8') <= maxBytes) return output;
  let trimmed = output;
  while (Buffer.byteLength(trimmed, 'utf8') > maxBytes) {
    trimmed = trimmed.slice(Math.max(1, trimmed.length - maxBytes));
  }
  return trimmed;
}

export class EmbeddedTerminalManager extends EventEmitter {
  private readonly sessions = new Map<string, ManagedPlanningTerminal>();
  private readonly repoRoot: string;
  private readonly logger?: Logger;
  private readonly spawnFn: SpawnFn;
  private readonly shell?: string;
  private readonly env?: NodeJS.ProcessEnv;
  private readonly maxOutputBufferBytes: number;

  constructor(options: EmbeddedTerminalManagerOptions) {
    super();
    this.repoRoot = options.repoRoot;
    this.logger = options.logger;
    this.spawnFn = options.spawn ?? spawn;
    this.shell = options.shell;
    this.env = options.env;
    this.maxOutputBufferBytes = options.maxOutputBufferBytes ?? DEFAULT_MAX_OUTPUT_BUFFER_BYTES;
  }

  openPlanningTerminal(request: OpenPlanningTerminalRequest): OpenPlanningTerminalResult {
    const planningSessionId = normalizePlanningSessionId(request.planningSessionId);
    const existing = this.sessions.get(planningSessionId);
    if (existing && existing.session.status === 'running') {
      existing.session.cols = normalizeDimension('cols', request.cols, existing.session.cols);
      existing.session.rows = normalizeDimension('rows', request.rows, existing.session.rows);
      existing.session.lastActiveAt = new Date().toISOString();
      return { session: { ...existing.session }, reused: true, output: existing.output };
    }

    const cols = normalizeDimension('cols', request.cols, DEFAULT_COLS);
    const rows = normalizeDimension('rows', request.rows, DEFAULT_ROWS);
    const { command, args } = resolveInteractiveShell(this.shell);
    const now = new Date().toISOString();
    const session: PlanningTerminalSession = {
      id: buildPlanningTerminalId(planningSessionId),
      kind: 'planning',
      planningSessionId,
      mode: 'manual',
      backend: 'process',
      cwd: this.repoRoot,
      cols,
      rows,
      status: 'running',
      createdAt: now,
      lastActiveAt: now,
    };

    let child: ChildProcess;
    try {
      child = this.spawnFn(command, args, {
        cwd: this.repoRoot,
        env: {
          ...process.env,
          ...this.env,
          TERM: this.env?.TERM ?? process.env.TERM ?? 'xterm-256color',
          INVOKER_TERMINAL_KIND: 'planning',
          INVOKER_TERMINAL_MODE: 'manual',
          INVOKER_PLANNING_SESSION_ID: planningSessionId,
        },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger?.error(`open planning terminal failed: ${message}`, { module: 'embedded-terminal' });
      throw err;
    }

    const managed: ManagedPlanningTerminal = {
      child,
      session,
      output: '',
      closing: false,
    };
    this.sessions.set(planningSessionId, managed);

    child.stdout?.on('data', (chunk: Buffer | string) => this.recordOutput(managed, chunk));
    child.stderr?.on('data', (chunk: Buffer | string) => this.recordOutput(managed, chunk));
    child.once('error', (err) => {
      this.logger?.error(`planning terminal process error: ${err.message}`, { module: 'embedded-terminal' });
      this.finishSession(planningSessionId, managed, null, null);
    });
    child.once('exit', (code, signal) => this.finishSession(planningSessionId, managed, code, signal));

    this.logger?.info(`opened planning terminal "${planningSessionId}" cwd=${this.repoRoot}`, {
      module: 'embedded-terminal',
    });
    return { session: { ...session }, reused: false, output: '' };
  }

  listPlanningTerminals(): PlanningTerminalSession[] {
    return Array.from(this.sessions.values()).map((entry) => ({ ...entry.session }));
  }

  writePlanningTerminal(request: PlanningTerminalWriteRequest): PlanningTerminalWriteResult {
    const planningSessionId = normalizePlanningSessionId(request.planningSessionId);
    const entry = this.requireRunningSession(planningSessionId);
    if (typeof request.data !== 'string') {
      throw new Error('data must be a string.');
    }
    entry.session.lastActiveAt = new Date().toISOString();
    const accepted = entry.child.stdin?.write(request.data) ?? false;
    return { accepted };
  }

  resizePlanningTerminal(request: PlanningTerminalResizeRequest): PlanningTerminalSession {
    const planningSessionId = normalizePlanningSessionId(request.planningSessionId);
    const entry = this.requireRunningSession(planningSessionId);
    entry.session.cols = normalizeDimension('cols', request.cols);
    entry.session.rows = normalizeDimension('rows', request.rows);
    entry.session.lastActiveAt = new Date().toISOString();
    return { ...entry.session };
  }

  closePlanningTerminal(request: PlanningTerminalCloseRequest): PlanningTerminalCloseResult {
    const planningSessionId = normalizePlanningSessionId(request.planningSessionId);
    const entry = this.sessions.get(planningSessionId);
    if (!entry) return { closed: false };

    entry.closing = true;
    this.sessions.delete(planningSessionId);
    if (entry.session.status === 'running') {
      entry.session.status = 'exited';
      entry.session.lastActiveAt = new Date().toISOString();
      entry.child.kill();
      this.emitClosed(entry);
    }
    return { closed: true };
  }

  dispose(): void {
    for (const planningSessionId of Array.from(this.sessions.keys())) {
      this.closePlanningTerminal({ planningSessionId });
    }
  }

  private requireRunningSession(planningSessionId: string): ManagedPlanningTerminal {
    const entry = this.sessions.get(planningSessionId);
    if (!entry || entry.session.status !== 'running') {
      throw new Error(`Planning terminal "${planningSessionId}" is not running.`);
    }
    return entry;
  }

  private recordOutput(entry: ManagedPlanningTerminal, chunk: Buffer | string): void {
    const data = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
    entry.output = trimOutputBuffer(entry.output + data, this.maxOutputBufferBytes);
    entry.session.lastActiveAt = new Date().toISOString();
    const event: PlanningTerminalOutputEvent = {
      sessionId: entry.session.id,
      planningSessionId: entry.session.planningSessionId,
      data,
    };
    this.emit('output', event);
  }

  private finishSession(
    planningSessionId: string,
    entry: ManagedPlanningTerminal,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (entry.session.status === 'exited') return;
    entry.session.status = 'exited';
    entry.session.exitCode = code;
    entry.session.signal = signal;
    entry.session.lastActiveAt = new Date().toISOString();
    this.sessions.delete(planningSessionId);
    this.emitClosed(entry);
  }

  private emitClosed(entry: ManagedPlanningTerminal): void {
    const event: PlanningTerminalClosedEvent = {
      session: { ...entry.session },
    };
    this.emit('closed', event);
  }
}
