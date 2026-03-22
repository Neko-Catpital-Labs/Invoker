import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { DockerPool } from './docker-pool.js';

const CONTAINER_STOP_TIMEOUT_S = 5;
const TAG = '[DockerFamiliar]';

export interface DockerFamiliarConfig {
  imageName?: string;
  workspaceDir: string;
  callbackPort?: number;
  claudeConfigDir?: string;
  sshDir?: string;
  cacheImages?: boolean;
  /** ANTHROPIC_API_KEY to pass into the container. Falls back to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
}

interface ContainerEntry extends BaseEntry {
  containerId: string;
  claudeSessionId?: string;
  /** Branch that was checked out before setupTaskBranch created the task branch. */
  originalBranch?: string;
}

/**
 * Familiar implementation that runs tasks inside Docker containers.
 *
 * For `actionType === 'claude'`, the container runs the Claude CLI directly.
 * The Docker image must have `claude` installed in $PATH.
 *
 * Requires the `dockerode` npm package at runtime.
 * If not installed, start() throws with installation instructions.
 */
export class DockerFamiliar extends BaseFamiliar<ContainerEntry> {
  readonly type = 'docker';

  private readonly imageName: string;
  private readonly workspaceDir: string;
  private readonly callbackPort: number;
  private readonly claudeConfigDir: string;
  private readonly sshDir: string;
  private readonly anthropicApiKey: string;
  private readonly pool: DockerPool | null = null;

  /** Lazily-resolved dockerode instance. Null until first use. */
  private dockerInstance: any | null = null;

  constructor(config: DockerFamiliarConfig) {
    super();
    this.imageName = config.imageName ?? 'invoker-agent:latest';
    this.workspaceDir = config.workspaceDir;
    this.callbackPort = config.callbackPort ?? 4000;
    this.claudeConfigDir = config.claudeConfigDir ?? join(homedir(), '.claude');
    this.sshDir = config.sshDir ?? join(homedir(), '.ssh');
    this.anthropicApiKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    if (config.cacheImages) {
      this.pool = new DockerPool({ baseImage: this.imageName });
    }
  }

  // ---------------------------------------------------------------------------
  // Docker initialisation
  // ---------------------------------------------------------------------------

  private async getDocker(): Promise<any> {
    if (this.dockerInstance) return this.dockerInstance;

    let Docker: any;
    try {
      const mod = await import('dockerode');
      Docker = mod.default ?? mod;
    } catch {
      throw new Error(
        "DockerFamiliar requires 'dockerode' package. Install with: pnpm add dockerode",
      );
    }

    this.dockerInstance = new Docker();
    return this.dockerInstance;
  }

  // ---------------------------------------------------------------------------
  // Familiar interface
  // ---------------------------------------------------------------------------

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    // Buffer logs before entry registration so they can be flushed to outputListeners
    const earlyLogs: string[] = [];
    const log = (msg: string) => { console.log(msg); earlyLogs.push(msg); };

    log(`${TAG} start() actionType=${request.actionType} actionId=${request.actionId}`);
    const docker = await this.getDocker();
    const handle = this.createHandle(request);

    // Determine container command based on action type
    let containerCmd: string[];
    let claudeSessionId: string | undefined;

    if (request.actionType === 'claude') {
      log(`${TAG} preparing Claude session for "${request.actionId}"`);
      const session = this.prepareClaudeSession(request);
      claudeSessionId = session.sessionId;
      containerCmd = ['claude', ...session.cliArgs];
      log(`${TAG} Claude sessionId=${claudeSessionId} prompt=${session.fullPrompt.slice(0, 100)}...`);
    } else if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      containerCmd = ['/bin/sh', '-c', command];
      log(`${TAG} command: ${command}`);
    } else {
      log(`${TAG} legacy/reconciliation action, writing request.json`);
      // For reconciliation or other types, write request.json for legacy agent scripts
      const invokerDir = join(this.workspaceDir, '.invoker');
      if (!existsSync(invokerDir)) {
        mkdirSync(invokerDir, { recursive: true });
      }
      writeFileSync(
        join(invokerDir, 'request.json'),
        JSON.stringify(request, null, 2),
      );
      containerCmd = [];
    }

    // Determine image: use cached image if pool + repoUrl, else default
    let containerImage = this.imageName;
    let useBindMount = true;

    if (this.pool && request.inputs.repoUrl) {
      try {
        containerImage = await this.pool.ensureImage(docker, request.inputs.repoUrl);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const msg of earlyLogs) {
          this.emitOutput(handle.executionId, msg + '\n');
        }
        this.emitOutput(handle.executionId, `${TAG} Image provisioning failed: ${errMsg}\n`);
        throw new Error(`Docker image provisioning failed: ${errMsg}`);
      }
      useBindMount = false; // Repo is inside the cached image
    }

    // Volume mounts
    const binds: string[] = [];
    if (useBindMount) {
      binds.push(`${this.workspaceDir}:/app`);
    } else {
      // Pool-based: repo is inside the image, but we still need .invoker dir
      const invokerDir = join(this.workspaceDir, '.invoker');
      binds.push(`${invokerDir}:/app/.invoker`);
    }

    // Mount Claude config read-write so sessions persist after container exit.
    // Also mount ~/.claude.json into .claude/ so the in-image symlink resolves.
    if (existsSync(this.claudeConfigDir)) {
      binds.push(`${this.claudeConfigDir}:/home/invoker/.claude`);
      const claudeJsonPath = join(homedir(), '.claude.json');
      if (existsSync(claudeJsonPath)) {
        binds.push(`${claudeJsonPath}:/home/invoker/.claude/.claude.json:ro`);
      }
    }
    if (existsSync(this.sshDir)) {
      binds.push(`${this.sshDir}:/home/invoker/.ssh:ro`);
    }

    const callbackUrl = `http://host.docker.internal:${this.callbackPort}/api/worker/response`;

    const containerConfig: Record<string, unknown> = {
      Image: containerImage,
      Tty: true,
      // Run as the host user so bind-mounted files are writable
      User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Env: [
        `ANTHROPIC_API_KEY=${this.anthropicApiKey}`,
        `INVOKER_CALLBACK_URL=${callbackUrl}`,
        `INVOKER_REQUEST_ID=${request.requestId}`,
        `INVOKER_ACTION_ID=${request.actionId}`,
        `HOME=/home/invoker`,
      ],
      HostConfig: {
        Binds: binds,
        NetworkMode: 'host',
        // On Linux, host.docker.internal isn't available by default.
        // Add an extra_hosts mapping so the container can reach the host.
        ...(process.platform === 'linux' ? {
          ExtraHosts: ['host.docker.internal:host-gateway'],
        } : {}),
      },
      WorkingDir: '/app',
    };

    if (containerCmd.length > 0) {
      containerConfig.Cmd = containerCmd;
      // Override any ENTRYPOINT from the image so Cmd runs directly
      containerConfig.Entrypoint = [];
    }

    // Full config goes to console only (too verbose for embedded terminal)
    console.log(`${TAG} Container config:`, JSON.stringify(containerConfig, null, 2));
    let container;
    try {
      container = await docker.createContainer(containerConfig);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      for (const msg of earlyLogs) {
        this.emitOutput(handle.executionId, msg + '\n');
      }
      this.emitOutput(handle.executionId, `${TAG} Container creation failed: ${errMsg}\n`);
      throw new Error(`Docker container creation failed: ${errMsg}`);
    }
    log(`${TAG} Container created: ${container.id.slice(0, 12)} image=${containerImage}`);

    const entry: ContainerEntry = {
      containerId: container.id,
      request,
      claudeSessionId,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };

    this.registerEntry(handle, entry);

    // Flush early logs to embedded terminal
    for (const msg of earlyLogs) {
      this.emitOutput(handle.executionId, msg + '\n');
    }

    // From here, emit directly to both console and embedded terminal
    const emit = (msg: string) => {
      console.log(msg);
      this.emitOutput(handle.executionId, msg + '\n');
    };

    handle.containerId = container.id;
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    // Pre-sync: pull latest from remote
    await this.syncFromRemote(this.workspaceDir, handle.executionId);

    // Create task-specific branch in main repo for tracking
    const originalBranch = await this.setupTaskBranch(this.workspaceDir, request, handle);
    entry.originalBranch = originalBranch;

    emit(`${TAG} Starting container ${container.id.slice(0, 12)}...`);
    try {
      await container.start();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit(`${TAG} Container failed to start: ${errMsg}`);
      throw new Error(`Docker container failed to start: ${errMsg}`);
    }
    emit(`${TAG} Container started`);

    // Attach log stream after starting; awaited to ensure listener is registered
    // before the caller adds their own onOutput listeners.
    await this.streamLogs(container, entry);

    // Monitor container exit
    this.monitorExit(container, handle.executionId, entry);

    return handle;
  }

  async kill(handle: FamiliarHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;

    const docker = await this.getDocker();
    const container = docker.getContainer(entry.containerId);

    try {
      await container.stop({ t: CONTAINER_STOP_TIMEOUT_S });
    } catch (err: any) {
      // Container may already be stopped
      if (!err.message?.includes('is not running') && !err.message?.includes('not running')) {
        throw err;
      }
    }

    try {
      await container.remove();
    } catch (err: any) {
      if (!err.message?.includes('No such container') && !err.message?.includes('removal of container')) {
        throw err;
      }
    }
  }

  sendInput(handle: FamiliarHandle, _input: string): void {
    // Docker containers communicate via the callback URL, not stdin.
    // This is a no-op for DockerFamiliar.
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
  }

  getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    console.log(`${TAG} getTerminalSpec() handle=${handle.executionId} hasEntry=${!!entry} claudeSessionId=${entry?.claudeSessionId} containerId=${entry?.containerId?.slice(0, 12)}`);
    if (!entry) return null;
    const cid = entry.containerId;
    if (entry.claudeSessionId) {
      console.log(`${TAG} getTerminalSpec() -> docker start + exec claude --resume ${entry.claudeSessionId}`);
      return {
        command: 'bash',
        args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} claude --resume ${entry.claudeSessionId}`],
      };
    }
    console.log(`${TAG} getTerminalSpec() -> docker start + exec /bin/bash`);
    return {
      command: 'bash',
      args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} /bin/bash`],
    };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" containerId="${meta.containerId ?? 'none'}" sessionId="${meta.claudeSessionId ?? 'none'}"`);
    if (!meta.containerId) {
      console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — no container ID`);
      throw new Error(`No container ID found for task ${meta.taskId}`);
    }
    const cid = meta.containerId;
    if (meta.claudeSessionId) {
      console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → docker exec claude --resume`);
      return {
        command: 'bash',
        args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} claude --resume ${meta.claudeSessionId} --dangerously-skip-permissions`],
      };
    }
    console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → docker exec /bin/bash`);
    return {
      command: 'bash',
      args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} /bin/bash`],
    };
  }

  async destroyAll(): Promise<void> {
    const docker = await this.getDocker();
    const killPromises: Promise<void>[] = [];

    for (const [, entry] of this.entries) {
      if (!entry.completed) {
        const container = docker.getContainer(entry.containerId);
        killPromises.push(
          (async () => {
            try {
              await container.stop({ t: CONTAINER_STOP_TIMEOUT_S });
            } catch {
              // ignore — may already be stopped
            }
            try {
              await container.remove();
            } catch {
              // ignore — may already be removed
            }
          })(),
        );
      }
    }

    await Promise.all(killPromises);
    this.entries.clear();

    // Destroy cached images if pool exists
    if (this.pool) {
      await this.pool.destroyAll(docker);
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private async streamLogs(container: any, entry: ContainerEntry): Promise<void> {
    try {
      const logStream = await container.logs({
        follow: true,
        stdout: true,
        stderr: true,
      });

      // With Tty: true, the stream is plain text (no multiplexed headers).
      logStream.on('data', (chunk: Buffer) => {
        const data = chunk.toString();
        entry.outputBuffer.push(data);
        for (const cb of entry.outputListeners) {
          cb(data);
        }
      });

      logStream.on('error', () => {
        // Log stream errors are non-fatal; container exit is tracked separately.
      });
    } catch {
      // If logs fail to attach, the container can still complete via monitorExit.
    }
  }

  private async monitorExit(container: any, executionId: string, entry: ContainerEntry): Promise<void> {
    try {
      const result = await container.wait();
      const exitCode: number = result.StatusCode ?? 1;
      await this.handleProcessExit(executionId, entry.request, this.workspaceDir, exitCode, {
        originalBranch: entry.originalBranch,
        claudeSessionId: entry.claudeSessionId,
      });
    } catch (err) {
      this.emitOutput(executionId, `${TAG} monitorExit error: ${err}\n`);
      await this.handleProcessExit(executionId, entry.request, this.workspaceDir, 1, {
        originalBranch: entry.originalBranch,
        claudeSessionId: entry.claudeSessionId,
      });
    }
  }
}
