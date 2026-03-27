import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
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
  /** When true, the image already contains the repo — skip DockerPool clone. */
  repoInImage?: boolean;
  /** ANTHROPIC_API_KEY to pass into the container. Falls back to process.env.ANTHROPIC_API_KEY. */
  anthropicApiKey?: string;
}

interface ContainerEntry extends BaseEntry {
  containerId: string;
  claudeSessionId?: string;
  /** Task branch name created inside the container. */
  branch?: string;
}

/**
 * Familiar implementation that runs tasks inside Docker containers.
 *
 * Images are fully isolated: the host repo is never bind-mounted. Instead,
 * the repo is either cloned into a cached Docker image (default) or
 * pre-loaded by the user (`repoInImage: true`). Git lifecycle (fetch,
 * branch, commit, push) runs inside the container via a wrapper script.
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
  // Git wrapper script builder
  // ---------------------------------------------------------------------------

  /**
   * Build a shell script that wraps the task command with git lifecycle:
   *   1. Configure git user
   *   2. Fetch origin and checkout task branch
   *   3. Merge upstream branches (for DAG fan-in)
   *   4. Run the actual task
   *   5. Commit results and push to remote
   */
  buildWrappedCommand(
    innerCmd: string[],
    branchName: string,
    request: WorkRequest,
  ): string[] {
    const base = request.inputs.upstreamBranches?.[0]
      ?? (request.inputs.baseBranch ? `origin/${request.inputs.baseBranch}` : 'origin/HEAD');
    const upstreams = request.inputs.upstreamBranches ?? [];
    const isClaudeTask = request.actionType === 'claude';

    const lines: string[] = [
      'set -e',
      'git config user.email "invoker@localhost"',
      'git config user.name "Invoker"',
      'git fetch origin',
      `git checkout -B ${this.shellEscape(branchName)} ${this.shellEscape(base)}`,
    ];

    // Merge additional upstream branches (fan-in)
    for (const ub of upstreams.slice(1)) {
      lines.push(`git merge --no-edit ${this.shellEscape(ub)}`);
    }

    lines.push('set +e');
    lines.push(innerCmd.map(a => this.shellEscape(a)).join(' '));
    lines.push('TASK_EXIT=$?');
    lines.push('set -e');

    if (!isClaudeTask) {
      const msg = this.buildCommitMessage(request);
      lines.push('git add -A');
      lines.push(`git commit --allow-empty -m ${this.shellEscape(msg)}`);
    }

    lines.push(`git push -u origin ${this.shellEscape(branchName)} || true`);
    lines.push('exit $TASK_EXIT');

    return ['/bin/bash', '-c', lines.join('\n')];
  }

  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
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

    // Compute branch name for this task (mirrors BaseFamiliar.setupTaskBranch logic)
    const branchName = `invoker/${request.actionId}`;
    handle.branch = branchName;

    // Determine the raw task command (before wrapping with git lifecycle)
    let innerCmd: string[];
    let claudeSessionId: string | undefined;

    if (request.actionType === 'claude') {
      log(`${TAG} preparing Claude session for "${request.actionId}"`);
      const session = this.prepareClaudeSession(request);
      claudeSessionId = session.sessionId;
      innerCmd = ['claude', ...session.cliArgs];
      log(`${TAG} Claude sessionId=${claudeSessionId} prompt=${session.fullPrompt.slice(0, 100)}...`);
    } else if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      innerCmd = ['/bin/sh', '-c', command];
      log(`${TAG} command: ${command}`);
    } else {
      innerCmd = ['/bin/sh', '-c', 'echo "Unsupported action type"; exit 1'];
    }

    // Wrap with git lifecycle
    const containerCmd = this.buildWrappedCommand(innerCmd, branchName, request);

    // Resolve container image
    let containerImage = this.imageName;
    if (!this.repoInImage) {
      const repoUrl = await this.resolveRepoUrl(request);
      try {
        containerImage = await this.pool.ensureImage(docker, repoUrl);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        for (const msg of earlyLogs) {
          this.emitOutput(handle.executionId, msg + '\n');
        }
        this.emitOutput(handle.executionId, `${TAG} Image provisioning failed: ${errMsg}\n`);
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
      ],
      HostConfig: {
        Binds: binds,
        NetworkMode: 'host',
        ...(process.platform === 'linux' ? {
          ExtraHosts: ['host.docker.internal:host-gateway'],
        } : {}),
      },
      WorkingDir: '/app',
      Cmd: containerCmd,
      Entrypoint: [],
    };

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
      branch: branchName,
      outputListeners: new Set(),
      outputBuffer: [],
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
    };

    this.registerEntry(handle, entry);

    for (const msg of earlyLogs) {
      this.emitOutput(handle.executionId, msg + '\n');
    }

    const emit = (msg: string) => {
      console.log(msg);
      this.emitOutput(handle.executionId, msg + '\n');
    };

    handle.containerId = container.id;
    if (claudeSessionId) {
      handle.claudeSessionId = claudeSessionId;
    }

    emit(`${TAG} Starting container ${container.id.slice(0, 12)}...`);
    try {
      await container.start();
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      emit(`${TAG} Container failed to start: ${errMsg}`);
      throw new Error(`Docker container failed to start: ${errMsg}`);
    }
    emit(`${TAG} Container started`);

    await this.streamLogs(container, entry);
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

    await this.pool.destroyAll(docker);
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

  /**
   * Docker-specific exit handler. Git operations (commit, push) already ran
   * inside the container via the wrapper script, so we only need to fetch the
   * commit hash from the remote and emit the completion response.
   */
  private async monitorExit(container: any, executionId: string, entry: ContainerEntry): Promise<void> {
    let exitCode = 1;
    try {
      const result = await container.wait();
      exitCode = result.StatusCode ?? 1;
    } catch (err) {
      this.emitOutput(executionId, `${TAG} monitorExit error: ${err}\n`);
    }

    entry.completed = true;
    const status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';

    this.emitOutput(executionId,
      `[${this.type}] Process exited: actionId=${entry.request.actionId} exitCode=${exitCode}\n`);

    // Extract commit hash from remote (the container pushed the branch)
    let commitHash: string | undefined;
    if (entry.branch) {
      try {
        await this.execGitSimple(['fetch', 'origin'], this.workspaceDir);
        commitHash = (await this.execGitSimple(
          ['rev-parse', `origin/${entry.branch}`], this.workspaceDir,
        )).trim();
      } catch {
        // Push may have failed inside the container — non-fatal
      }
    }

    let error: string | undefined;
    if (exitCode !== 0) {
      const allOutput = entry.outputBuffer.join('');
      const lines = allOutput.split('\n');
      const tail = lines.slice(-50).join('\n').trim();
      if (tail) {
        error = tail.length > 3000 ? tail.slice(-3000) : tail;
      }
    }

    const response: WorkResponse = {
      requestId: entry.request.requestId,
      actionId: entry.request.actionId,
      status,
      outputs: {
        exitCode: status === 'failed' && exitCode === 0 ? 1 : exitCode,
        commitHash,
        claudeSessionId: entry.claudeSessionId,
        ...(error ? { error } : {}),
        ...(entry.branch ? { summary: `branch=${entry.branch} commit=${commitHash ?? 'unknown'}` } : {}),
      },
    };
    this.emitComplete(executionId, response);
  }
}
