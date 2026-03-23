import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';

export interface SshFamiliarConfig {
  host: string;
  user: string;
  /** Path to SSH identity file (private key). */
  sshKeyPath: string;
  /** SSH port. Default: 22. */
  port?: number;
}

interface SshEntry extends BaseEntry {
  process: ChildProcess | null;
  claudeSessionId?: string;
}

/**
 * Familiar that executes tasks on a remote machine via SSH key-based auth.
 *
 * Spawns `ssh -i <keyPath> -p <port> user@host <command>` for command tasks
 * and runs the Claude CLI remotely for claude tasks.
 */
export class SshFamiliar extends BaseFamiliar<SshEntry> {
  readonly type = 'ssh';

  private readonly host: string;
  private readonly user: string;
  private readonly sshKeyPath: string;
  private readonly port: number;

  constructor(config: SshFamiliarConfig) {
    super();
    this.host = config.host;
    this.user = config.user;
    this.sshKeyPath = config.sshKeyPath;
    this.port = config.port ?? 22;
  }

  private buildSshArgs(): string[] {
    return [
      '-i', this.sshKeyPath,
      '-p', String(this.port),
      '-o', 'StrictHostKeyChecking=accept-new',
      '-o', 'BatchMode=yes',
      `${this.user}@${this.host}`,
    ];
  }

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    const handle = this.createHandle(request);
    const executionId = handle.executionId;

    if (request.actionType === 'reconciliation') {
      const entry: SshEntry = {
        process: null,
        request,
        outputListeners: new Set(),
        outputBuffer: [],
        completeListeners: new Set(),
        heartbeatListeners: new Set(),
        completed: false,
      };
      this.registerEntry(handle, entry);
      this.scheduleReconciliationResponse(executionId);
      return handle;
    }

    const sshBase = this.buildSshArgs();
    let remoteCommand: string;
    let claudeSessionId: string | undefined;

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      remoteCommand = command;
    } else if (request.actionType === 'claude') {
      const session = this.prepareClaudeSession(request);
      claudeSessionId = session.sessionId;
      remoteCommand = `claude ${session.cliArgs.map(a => this.shellQuote(a)).join(' ')}`;
    } else {
      remoteCommand = 'echo "Unsupported action type"';
    }

    const child = spawn('ssh', [...sshBase, remoteCommand], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: cleanElectronEnv(),
    });

    const entry: SshEntry = {
      process: child,
      request,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
      claudeSessionId,
    };

    this.registerEntry(handle, entry);
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', (code, signal) => {
      const exitCode = code ?? (signal ? 1 : 0);
      const e = this.entries.get(executionId);
      if (e) e.completed = true;

      const status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status,
        outputs: {
          exitCode,
          claudeSessionId: entry.claudeSessionId,
        },
      };
      this.emitComplete(executionId, response);
    });

    this.startHeartbeat(executionId, child);
    return handle;
  }

  async kill(handle: FamiliarHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed || !entry.process) return;

    await new Promise<void>((resolve) => {
      const child = entry.process!;

      const killTimer = setTimeout(() => {
        if (!entry.completed) {
          killProcessGroup(child, 'SIGKILL');
        }
      }, SIGKILL_TIMEOUT_MS);

      child.on('close', () => {
        clearTimeout(killTimer);
        resolve();
      });

      if (entry.completed) {
        clearTimeout(killTimer);
        resolve();
        return;
      }

      killProcessGroup(child, 'SIGTERM');
    });
  }

  sendInput(handle: FamiliarHandle, input: string): void {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return null;
    return {
      command: 'ssh',
      args: this.buildSshArgs(),
    };
  }

  getRestoredTerminalSpec(_meta: PersistedTaskMeta): TerminalSpec {
    return {
      command: 'ssh',
      args: this.buildSshArgs(),
    };
  }

  async destroyAll(): Promise<void> {
    const allEntries = Array.from(this.entries.entries());
    const closePromises: Promise<void>[] = [];

    for (const [_executionId, entry] of allEntries) {
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
  }

  /** Shell-quote a string for safe inclusion in a remote SSH command. */
  private shellQuote(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
}
