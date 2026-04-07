import { spawn, type ChildProcess } from 'node:child_process';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { loadSecretsFile } from './secrets-loader.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { computeBranchHash } from './branch-utils.js';
import type { AgentRegistry } from './agent-registry.js';

const CONTAINER_STOP_TIMEOUT_S = 5;
const TAG = '[DockerFamiliar]';
const CONTAINER_CWD = '/app';

export interface DockerFamiliarConfig {
  imageName?: string;
  callbackPort?: number;
  /** Path to a dotenv-style file whose entries are appended to the container env. */
  secretsFile?: string;
  /** Agent registry for pluggable agent command building. */
  agentRegistry?: AgentRegistry;
}

interface ContainerEntry extends BaseEntry {
  containerId: string;
  process: ChildProcess | null;
  agentSessionId?: string;
  branch?: string;
}

function shellEscape(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/**
 * Familiar that runs tasks inside Docker containers.
 *
 * The container image is treated as a static artifact: it declares its own
 * user, HOME, installed tools, and repo contents. DockerFamiliar owns only
 * container lifecycle — no bind mounts, no user overrides, no HOME injection.
 *
 * Secrets come from an optional host file (`secretsFile`) whose entries are
 * appended to the container env alongside task-identity fields
 * (`INVOKER_CALLBACK_URL`, `INVOKER_REQUEST_ID`, `INVOKER_ACTION_ID`).
 *
 * Git lifecycle is handled by overriding `execGitSimple` to route through
 * `docker exec`, so all BaseFamiliar git methods (syncFromRemote,
 * setupTaskBranch, handleProcessExit) work inside the container with zero
 * duplication. The container runs an idle process (`tail -f /dev/null`)
 * and all operations happen via `docker exec`.
 */
export class DockerFamiliar extends BaseFamiliar<ContainerEntry> {
  readonly type = 'docker';

  private readonly imageName: string;
  private readonly callbackPort: number;
  private readonly secretsFile: string | undefined;
  private readonly agentRegistry?: AgentRegistry;

  /** Lazily-resolved dockerode instance. Null until first use. */
  private dockerInstance: any | null = null;

  /** Container ID for the current task (set after container.start()). */
  private activeContainerId: string | null = null;

  constructor(config: DockerFamiliarConfig) {
    super();
    this.imageName = config.imageName ?? 'invoker/agent-base:latest';
    this.callbackPort = config.callbackPort ?? 4000;
    this.secretsFile = config.secretsFile;
    this.agentRegistry = config.agentRegistry;
  }

  // ---------------------------------------------------------------------------
  // Transport: execGitSimple override
  // ---------------------------------------------------------------------------

  /**
   * When a container is active, route git commands through `docker exec`
   * running as the image's declared user. Falls back to local git for
   * pre-container operations (e.g. resolveRepoUrl on the host).
   */
  protected override execGitSimple(args: string[], cwd: string): Promise<string> {
    if (!this.activeContainerId) return super.execGitSimple(args, cwd);
    const escapedArgs = args.map(a => shellEscape(a)).join(' ');
    const script = `cd ${shellEscape(cwd)} && git ${escapedArgs}`;
    return this.execRemoteCapture(script);
  }

  protected override runBash(script: string, _cwd: string): Promise<string> {
    return this.execRemoteCapture(script);
  }

  /**
   * Run a bash script inside the active container via CLI. Inherits the
   * image's declared user.
   */
  private execRemoteCapture(script: string): Promise<string> {
    const containerId = this.activeContainerId;
    if (!containerId) {
      return Promise.reject(new Error('execRemoteCapture called with no active container'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn('docker', [
        'exec', '-i', containerId, 'bash', '-s',
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

    log(`${TAG} image=${this.imageName}`);

    const callbackUrl = `http://host.docker.internal:${this.callbackPort}/api/worker/response`;

    const env: string[] = [
      `INVOKER_CALLBACK_URL=${callbackUrl}`,
      `INVOKER_REQUEST_ID=${request.requestId}`,
      `INVOKER_ACTION_ID=${request.actionId}`,
    ];

    // Append secrets from host file (no-op when file absent or path unset).
    try {
      env.push(...loadSecretsFile(this.secretsFile));
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      for (const msg of earlyLogs) {
        this.emitOutput(executionId, msg + '\n');
      }
      this.emitOutput(executionId, `${TAG} Failed to load secrets: ${errMsg}\n`);
      throw new Error(`Failed to load secrets file: ${errMsg}`);
    }

    const containerConfig: Record<string, unknown> = {
      Image: this.imageName,
      Tty: true,
      Env: env,
      HostConfig: {
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
    log(`${TAG} Container created: ${container.id.slice(0, 12)} image=${this.imageName}`);

    // Determine task command and Claude session before entry registration
    const { cmd, args: cmdArgs, agentSessionId } = this.buildCommandAndArgs(request, {
      agentRegistry: this.agentRegistry,
    });

    const entry: ContainerEntry = {
      containerId: container.id,
      process: null,
      request,
      agentSessionId,
      outputListeners: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
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
    if (agentSessionId) {
      handle.agentSessionId = agentSessionId;
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

    // -- Git setup (reuses BaseFamiliar methods via overridden execGitSimple + runBash) --
    await this.syncFromRemote(CONTAINER_CWD, executionId);

    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const baseHead = (await this.execGitSimple(['rev-parse', baseRef], CONTAINER_CWD)).trim();
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((h): h is string => !!h);
    const hash = computeBranchHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
      request.inputs.salt,
    );
    const branchName = `experiment/${request.actionId}-${hash}`;
    const baseBranch = request.inputs.upstreamBranches?.[0]
      ?? request.inputs.baseBranch
      ?? 'HEAD';

    await this.setupTaskBranch(CONTAINER_CWD, request, handle, {
      branchName,
      base: baseBranch,
    });
    entry.branch = handle.branch;

    // -- No-command tasks: complete immediately after branch setup --
    if (!request.inputs.command && !request.inputs.prompt) {
      await this.handleProcessExit(executionId, request, CONTAINER_CWD, 0, {
        branch: handle.branch,
      });
      return handle;
    }

    // -- Spawn task command via docker exec CLI --
    const taskCmd = `cd ${shellEscape(CONTAINER_CWD)} && exec ${cmd} ${cmdArgs.map(a => shellEscape(a)).join(' ')}`;
    const child = spawn('docker', [
      'exec', '-i', container.id, 'bash', '-c', taskCmd,
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
          agentSessionId: entry.agentSessionId,
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
    console.log(`${TAG} getTerminalSpec() handle=${handle.executionId} hasEntry=${!!entry} agentSessionId=${entry?.agentSessionId} containerId=${entry?.containerId?.slice(0, 12)}`);
    if (!entry) return null;
    const cid = entry.containerId;
    if (entry.agentSessionId) {
      // NOTE: Claude CLI's interactive TUI has known freeze/deadlock issues inside
      // Docker containers (see github.com/anthropics/claude-code/issues/20572,
      // #24068, #25286). The --resume terminal may hang after the trust prompt.
      // The automated -p (pipe) execution path is unaffected.
      const agentName = entry.request.inputs.executionAgent ?? 'claude';
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(agentName).buildResumeArgs(entry.agentSessionId)
        : { cmd: 'claude', args: ['--resume', entry.agentSessionId, '--dangerously-skip-permissions'] };
      const resumeCmd = [resume.cmd, ...resume.args].join(' ');
      console.log(`${TAG} getTerminalSpec() -> docker start + exec ${resumeCmd}`);
      return {
        command: 'bash',
        args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} ${resumeCmd}`],
      };
    }
    console.log(`${TAG} getTerminalSpec() -> docker start + exec /bin/bash`);
    return {
      command: 'bash',
      args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} /bin/bash`],
    };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" containerId="${meta.containerId ?? 'none'}" sessionId="${meta.agentSessionId ?? 'none'}"`);
    if (!meta.containerId) {
      console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" — no container ID`);
      throw new Error(`No container ID found for task ${meta.taskId}`);
    }
    const cid = meta.containerId;
    if (meta.agentSessionId) {
      // NOTE: Claude CLI's interactive TUI has known freeze/deadlock issues inside
      // Docker containers (see github.com/anthropics/claude-code/issues/20572,
      // #24068, #25286). The --resume terminal may hang after the trust prompt.
      const resume = this.agentRegistry
        ? this.agentRegistry.getOrThrow(meta.executionAgent ?? 'claude').buildResumeArgs(meta.agentSessionId)
        : { cmd: 'claude', args: ['--resume', meta.agentSessionId, '--dangerously-skip-permissions'] };
      const resumeCmd = [resume.cmd, ...resume.args].join(' ');
      console.log(`[DockerFamiliar] getRestoredTerminalSpec task="${meta.taskId}" → docker exec ${resumeCmd}`);
      return {
        command: 'bash',
        args: ['-c', `docker start ${cid} >/dev/null 2>&1; docker exec -it ${cid} ${resumeCmd}`],
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
  }
}
