import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { DockerPool } from './docker-pool.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';

const CONTAINER_STOP_TIMEOUT_S = 5;
const TAG = '[DockerFamiliar]';
const CONTAINER_CWD = '/app';

export interface DockerFamiliarConfig {
  imageName?: string;
  workspaceDir: string;
  callbackPort?: number;
  claudeConfigDir?: string;
  sshDir?: string;
  /** When true, the image already contains the repo — skip DockerPool clone. */
  repoInImage?: boolean;
  /** ANTHROPIC_API_KEY to pass into the container. Falls back to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
}

interface ContainerEntry extends BaseEntry {
  containerId: string;
  process: ChildProcess | null;
  claudeSessionId?: string;
  branch?: string;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Familiar that runs tasks inside Docker containers.
 *
 * Git lifecycle is handled by overriding `execGitSimple` to route through
 * `docker exec` CLI, so all BaseFamiliar git methods (syncFromRemote,
 * setupTaskBranch, handleProcessExit) work inside the container with zero
 * duplication. The container runs an idle process (`tail -f /dev/null`)
 * and all operations happen via `docker exec`.
 */
export class DockerFamiliar extends BaseFamiliar<ContainerEntry> {
  readonly type = 'docker';

  private readonly imageName: string;
  private readonly workspaceDir: string;
  private readonly callbackPort: number;
  private readonly claudeConfigDir: string;
  private readonly sshDir: string;
  private readonly anthropicApiKey: string;
  private readonly repoInImage: boolean;
  private readonly pool: DockerPool;

  /** Lazily-resolved dockerode instance. Null until first use. */
  private dockerInstance: any | null = null;

  /** Container ID for the current task (set after container.start()). */
  private activeContainerId: string | null = null;

  constructor(config: DockerFamiliarConfig) {
    super();
    this.imageName = config.imageName ?? 'invoker-agent:latest';
    this.workspaceDir = config.workspaceDir;
    this.callbackPort = config.callbackPort ?? 4000;
    this.claudeConfigDir = config.claudeConfigDir ?? join(homedir(), '.claude');
    this.sshDir = config.sshDir ?? join(homedir(), '.ssh');
    this.anthropicApiKey = config.anthropicApiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.repoInImage = config.repoInImage ?? false;
    this.pool = new DockerPool({ baseImage: this.imageName, sshDir: this.sshDir });
  }

  // ---------------------------------------------------------------------------
  // Transport: execGitSimple override
  // ---------------------------------------------------------------------------

  /**
   * When a container is active, route git commands through `docker exec`
   * running as root. Falls back to local git for pre-container operations
   * (e.g. resolveRepoUrl on the host).
   */
  protected override execGitSimple(args: string[], cwd: string): Promise<string> {
    if (!this.activeContainerId) return super.execGitSimple(args, cwd);
    const escapedArgs = args.map(a => shellEscape(a)).join(' ');
    const script = `cd ${shellEscape(cwd)} && git ${escapedArgs}`;
    return this.execRemoteCapture(script);
  }

  /**
   * Run a bash script inside the active container as root via CLI.
   * Uses `docker exec --user 0:0` so SSH keys at /root/.ssh are accessible.
   */
  private execRemoteCapture(script: string): Promise<string> {
    const containerId = this.activeContainerId;
    if (!containerId) {
      return Promise.reject(new Error('execRemoteCapture called with no active container'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'exec', '-i', '--user', '0:0', containerId, 'bash', '-s',
      ], { stdio: ['pipe', 'pipe', 'pipe'] });
      child.stdin!.write(script);
      child.stdin!.end();
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
      child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve(stdout.trim());
        else {
          const details = [stderr.trim(), stdout.trim()].filter(Boolean).join('\n');
          reject(new Error(`docker exec failed (code ${code}): ${details}`));
        }
      });
    });
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
  // Repo URL resolution
  // ---------------------------------------------------------------------------

  private async resolveRepoUrl(request: WorkRequest): Promise<string> {
    if (request.inputs.repoUrl) return request.inputs.repoUrl;
    try {
      return await this.execGitSimple(['remote', 'get-url', 'origin'], this.workspaceDir);
    } catch {
      throw new Error(
        `Docker task "${request.actionId}" requires a repoUrl but none was provided and ` +
        `"git remote get-url origin" failed in ${this.workspaceDir}. ` +
        `Either add repoUrl to your plan YAML, set docker.repoInImage in .invoker.json, ` +
        `or ensure the repo has an origin remote.`,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Familiar interface
  // ---------------------------------------------------------------------------

  async start(request: WorkRequest): Promise<FamiliarHandle> {
    const earlyLogs: string[] = [];
    const log = (msg: string) => { console.log(msg); earlyLogs.push(msg); };

    log(`${TAG} start() actionType=${request.actionType} actionId=${request.actionId}`);
    const docker = await this.getDocker();
    try {
      await docker.ping();
    } catch (err) {
      throw new Error(
        `Docker daemon is not reachable. Is Docker running?\n` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const handle = this.createHandle(request);
    const executionId = handle.executionId;

    // Resolve container image (before container creation)
    let containerImage = this.imageName;
    if (!this.repoInImage) {
      const repoUrl = await this.resolveRepoUrl(request);
      try {
        containerImage = await this.pool.ensureImage(docker, repoUrl);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const msg of earlyLogs) {
          this.emitOutput(executionId, msg + '\n');
        }
        this.emitOutput(executionId, `${TAG} Image provisioning failed: ${errMsg}\n`);
        throw new Error(`Docker image provisioning failed: ${errMsg}`);
      }
    }
    log(`${TAG} image=${containerImage} repoInImage=${this.repoInImage}`);

    // Volume mounts — never mount workspaceDir
    const binds: string[] = [];
    if (existsSync(this.claudeConfigDir)) {
      binds.push(`${this.claudeConfigDir}:/home/invoker/.claude`);
      const claudeJsonPath = join(homedir(), '.claude.json');
      if (existsSync(claudeJsonPath)) {
        binds.push(`${claudeJsonPath}:/home/invoker/.claude/.claude.json:ro`);
      }
    }
    if (existsSync(this.sshDir)) {
      binds.push(`${this.sshDir}:/home/invoker/.ssh:ro`);
      binds.push(`${this.sshDir}:/root/.ssh:ro`);
    }

    const callbackUrl = `http://host.docker.internal:${this.callbackPort}/api/worker/response`;

    const containerConfig: Record<string, unknown> = {
      Image: containerImage,
      Tty: true,
      User: `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      Env: [
        `ANTHROPIC_API_KEY=${this.anthropicApiKey}`,
        `INVOKER_CALLBACK_URL=${callbackUrl}`,
        `INVOKER_REQUEST_ID=${request.requestId}`,
        `INVOKER_ACTION_ID=${request.actionId}`,
        `HOME=/home/invoker`,
        `COREPACK_HOME=/opt/corepack`,
      ],
      HostConfig: {
        Binds: binds,
        NetworkMode: 'host',
        ...(process.platform === 'linux' ? {
          ExtraHosts: ['host.docker.internal:host-gateway'],
        } : {}),
      },
      WorkingDir: CONTAINER_CWD,
      Cmd: ['tail', '-f', '/dev/null'],
      Entrypoint: [],
    };

    console.log(`${TAG} Container config:`, JSON.stringify(containerConfig, null, 2));
    let container;
    try {
      container = await docker.createContainer(containerConfig);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      for (const msg of earlyLogs) {
        this.emitOutput(executionId, msg + '\n');
      }
      this.emitOutput(executionId, `${TAG} Container creation failed: ${errMsg}\n`);
      throw new Error(`Docker container creation failed: ${errMsg}`);
    }
    log(`${TAG} Container created: ${container.id.slice(0, 12)} image=${containerImage}`);

    // Determine task command and Claude session before entry registration
    const { cmd, args: cmdArgs, claudeSessionId } = this.buildCommandAndArgs(request);

    const entry: ContainerEntry = {
      containerId: container.id,
      process: null,
      request,
      claudeSessionId,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };

    this.registerEntry(handle, entry);

    for (const msg of earlyLogs) {
      this.emitOutput(executionId, msg + '\n');
    }

    const emit = (msg: string) => {
      console.log(msg);
      this.emitOutput(executionId, msg + '\n');
    };

    handle.containerId = container.id;
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    // -- Start container (idle process) --
    emit(`${TAG} Starting container ${container.id.slice(0, 12)}...`);
    try {
      await container.start();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit(`${TAG} Container failed to start: ${errMsg}`);
      throw new Error(`Docker container failed to start: ${errMsg}`);
    }
    this.activeContainerId = container.id;
    emit(`${TAG} Container started`);

    // -- One-time git config inside the container (as root) --
    try {
      await this.execRemoteCapture(
        'git config --global core.sshCommand "ssh -o StrictHostKeyChecking=accept-new -F /dev/null" && ' +
        'git config --global user.email "invoker@localhost" && ' +
        'git config --global user.name "Invoker"',
      );
    } catch (err) {
      emit(`${TAG} git config failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    // -- Git setup (reuses BaseFamiliar methods via overridden execGitSimple) --
    await this.syncFromRemote(CONTAINER_CWD, executionId);

    const branchName = `invoker/${request.actionId}`;
    const baseBranch = request.inputs.upstreamBranches?.[0]
      ?? request.inputs.baseBranch
      ?? 'HEAD';

    await this.setupTaskBranch(CONTAINER_CWD, request, handle, {
      branchName,
      base: baseBranch,
    });
    entry.branch = handle.branch;

    // -- Spawn task command via docker exec CLI --
    const taskCmd = `cd ${shellEscape(CONTAINER_CWD)} && exec ${cmd} ${cmdArgs.map(a => shellEscape(a)).join(' ')}`;
    const uid = process.getuid?.() ?? 1000;
    const gid = process.getgid?.() ?? 1000;
    const child = spawn('docker', [
      'exec', '-i', '--user', `${uid}:${gid}`, container.id, 'bash', '-c', taskCmd,
    ], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: cleanElectronEnv(),
    });

    entry.process = child;

    child.on('error', (err) => {
      emit(`${TAG} task process spawn error: ${err.message}`);
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `Failed to spawn docker exec: ${err.message}`,
        },
      };
      this.emitComplete(executionId, response);
    });

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', (code, signal) => {
      void (async () => {
        const exitCode = code ?? (signal ? 1 : 0);

        await this.handleProcessExit(executionId, request, CONTAINER_CWD, exitCode, {
          signal,
          branch: handle.branch,
          claudeSessionId: entry.claudeSessionId,
        });

        // Stop the idle container after git finalize completes
        try {
          const c = docker.getContainer(container.id);
          await c.stop({ t: CONTAINER_STOP_TIMEOUT_S });
        } catch {
          // Container may already be stopped
        }
      })();
    });

    this.startHeartbeat(executionId, child);
    return handle;
  }

  async kill(handle: FamiliarHandle): Promise<void> {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;

    // Kill the task process (docker exec) if running
    if (entry.process && !entry.process.killed) {
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

    // Stop and remove the container
    const docker = await this.getDocker();
    const container = docker.getContainer(entry.containerId);

    try {
      await container.stop({ t: CONTAINER_STOP_TIMEOUT_S });
    } catch (err: any) {
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

  sendInput(handle: FamiliarHandle, input: string): void {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  getTerminalSpec(handle: FamiliarHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    console.log(`${TAG} getTerminalSpec() handle=${handle.executionId} hasEntry=${!!entry} claudeSessionId=${entry?.claudeSessionId} containerId=${entry?.containerId?.slice(0, 12)}`);
    if (!entry) return null;
    const cid = entry.containerId;
    if (entry.claudeSessionId) {
      // NOTE: Claude CLI's interactive TUI has known freeze/deadlock issues inside
      // Docker containers (see github.com/anthropics/claude-code/issues/20572,
      // #24068, #25286). The --resume terminal may hang after the trust prompt.
      // The automated -p (pipe) execution path is unaffected.
      console.log(`${TAG} getTerminalSpec() -> docker start + exec claude --resume ${entry.claudeSessionId}`);
      return {
        command: 'bash',
        args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} claude --resume ${entry.claudeSessionId} --dangerously-skip-permissions`],
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
      // NOTE: Claude CLI's interactive TUI has known freeze/deadlock issues inside
      // Docker containers (see github.com/anthropics/claude-code/issues/20572,
      // #24068, #25286). The --resume terminal may hang after the trust prompt.
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
        if (entry.process && !entry.process.killed) {
          try { killProcessGroup(entry.process, 'SIGKILL'); } catch { /* */ }
        }
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

    await this.pool.destroyAll(docker);
  }
}
