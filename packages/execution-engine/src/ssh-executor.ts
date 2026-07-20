import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { normalize } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import { BaseExecutor, type BaseEntry } from './base-executor.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { computeContentHash, buildExperimentBranchName } from './branch-utils.js';
import { planManagedWorktree } from './managed-worktree-controller.js';
import { findManagedWorktreeForBranch, abbrevRefMatchesBranch } from './worktree-discovery.js';
import type { AgentRegistry } from './agent-registry.js';
import { assertExecutionModelSupported, DEFAULT_EXECUTION_AGENT } from './agent.js';
import { computeRepoUrlHash, sanitizeBranchForPath } from './git-utils.js';
import { isWorkspaceCleanupEnabled } from './workspace-cleanup-policy.js';
import { buildSshConnectionArgs } from './ssh-transport-options.js';
import { createExecutionBench } from './execution-bench.js';
import { buildRemoteAgentEnvExports } from './remote-agent-env.js';
import {
  shellPosixSingleQuote as sshGitShellQuote,
  sshInteractiveCdFragment,
  buildMirrorCloneScript,
  parseBootstrapOutput,
  buildWorktreeListScript,
  buildWorktreeHeadScript,
  buildWorktreeCleanupScript,
  buildWorktreeSandboxResetScript,
  buildRecordAndPushScript,
  parseRecordAndPushOutput,
  createSshRemoteScriptError,
  parseOwnedWorktreePath,
} from './ssh-git-exec.js';

export interface SshExecutorConfig {
  host: string;
  user: string;
  /** Path to SSH identity file (private key). */
  sshKeyPath: string;
  /** SSH port. Default: 22. */
  port?: number;
  /** Agent registry for pluggable agent command building. */
  agentRegistry?: AgentRegistry;
  /**
   * When true, use managed workspace mode: clone/fetch repo, create/reset worktrees,
   * then run the task in that checkout. When false (default), BYO mode: user provides
   * pre-cloned repo path and handles all git/setup operations.
   */
  managedWorkspaces?: boolean;
  /**
   * Remote invoker home directory (e.g., ~/.invoker). Only used in managed mode.
   * Default: ~/.invoker
   */
  remoteInvokerHome?: string;
  /** Opt-in: export agent API keys from secretsFile into remote task shells. */
  useApiKey?: boolean;
  /** Optional local secrets file used when useApiKey is true. */
  secretsFile?: string;
  /**
   * Optional remote command to hydrate a managed workspace before the task
   * payload runs. BYO workspaces are expected to be pre-provisioned.
   */
  provisionCommand?: string;
  /**
   * Remote workload heartbeat interval (seconds) emitted by the SSH payload wrapper.
   * Default: 30.
   */
  remoteHeartbeatIntervalSeconds?: number;
}

interface SshEntry extends BaseEntry {
  process: ChildProcess | null;
  agentSessionId?: string;
}

/**
 * Executor that executes tasks on a remote machine via SSH key-based auth.
 *
 * Requires `repoUrl` on the work request. Clones / worktrees on the remote
 * under ~/.invoker (mirroring local RepoPool layout), then runs the task
 * (command or Claude) in that directory. Always produces a branch and commits
 * on completion.
 */
export class SshExecutor extends BaseExecutor<SshEntry> {
  readonly type = 'ssh';
  private static readonly REMOTE_HEARTBEAT_MARKER = '__INVOKER_REMOTE_HEARTBEAT__';
  private static readonly DEFAULT_REMOTE_HEARTBEAT_INTERVAL_SECONDS = 30;

  private readonly host: string;
  private readonly user: string;
  private readonly sshKeyPath: string;
  private readonly port: number;
  private readonly agentRegistry?: AgentRegistry;
  private readonly managedWorkspaces: boolean;
  private readonly remoteInvokerHome: string;
  private readonly useApiKey: boolean;
  private readonly secretsFile: string | undefined;
  private readonly provisionCommand: string | undefined;
  private readonly remoteHeartbeatIntervalSeconds: number;
  private readonly remotePath: string;

  constructor(config: SshExecutorConfig) {
    super();
    this.host = config.host;
    this.user = config.user;
    this.sshKeyPath = config.sshKeyPath;
    this.port = config.port ?? 22;
    this.agentRegistry = config.agentRegistry;
    this.managedWorkspaces = config.managedWorkspaces ?? false;
    this.remoteInvokerHome = config.remoteInvokerHome ?? '~/.invoker';
    this.useApiKey = config.useApiKey === true;
    this.secretsFile = config.secretsFile;
    this.provisionCommand = config.provisionCommand;
    const configuredRemoteHeartbeatInterval = config.remoteHeartbeatIntervalSeconds;
    this.remoteHeartbeatIntervalSeconds =
      typeof configuredRemoteHeartbeatInterval === 'number'
      && Number.isFinite(configuredRemoteHeartbeatInterval)
      && configuredRemoteHeartbeatInterval > 0
        ? configuredRemoteHeartbeatInterval
        : SshExecutor.DEFAULT_REMOTE_HEARTBEAT_INTERVAL_SECONDS;
    this.remotePath = process.env.PATH ?? '';
  }

  private buildSshArgs(): string[] {
    return buildSshConnectionArgs({
      sshKeyPath: this.sshKeyPath,
      port: this.port,
      user: this.user,
      host: this.host,
    }, { batchMode: true });
  }

  /** SSH args without `BatchMode` so `-t` / interactive sessions work for external Terminal.app. */
  private buildSshArgsInteractive(): string[] {
    return buildSshConnectionArgs({
      sshKeyPath: this.sshKeyPath,
      port: this.port,
      user: this.user,
      host: this.host,
    }, { batchMode: false });
  }

  private buildRunnerScript(): string {
    const intervalSeconds = this.remoteHeartbeatIntervalSeconds;
    return `#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <payload-script>" >&2
  exit 2
fi

PAYLOAD_PATH=$1
(
  bash "$PAYLOAD_PATH"
) &
PAYLOAD_PID=$!
INVOKER_HEARTBEAT_MARKER=${this.shellQuote(SshExecutor.REMOTE_HEARTBEAT_MARKER)}
INVOKER_HEARTBEAT_INTERVAL_SECONDS=${intervalSeconds}
printf '%s %s\\n' "$INVOKER_HEARTBEAT_MARKER" "$(date +%s)"
(
  while kill -0 "$PAYLOAD_PID" 2>/dev/null; do
    sleep "$INVOKER_HEARTBEAT_INTERVAL_SECONDS"
    kill -0 "$PAYLOAD_PID" 2>/dev/null || break
    printf '%s %s\\n' "$INVOKER_HEARTBEAT_MARKER" "$(date +%s)"
  done
) &
HEARTBEAT_PID=$!
if wait "$PAYLOAD_PID"; then
  PAYLOAD_EXIT=0
else
  PAYLOAD_EXIT=$?
fi
kill "$HEARTBEAT_PID" >/dev/null 2>&1 || true
wait "$HEARTBEAT_PID" 2>/dev/null || true
exit "$PAYLOAD_EXIT"
`;
  }


  private buildPayloadScript(payload: string): string {
    return `#!/usr/bin/env bash
set -e
${payload}
`;
  }

  private safePathToken(value: string): string {
    const token = value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
    return token || 'task';
  }

  private buildStagingDirExpression(executionId: string, actionId: string): string {
    const safeExecutionId = this.safePathToken(executionId);
    const safeActionId = this.safePathToken(actionId).slice(0, 80);
    return `${safeExecutionId}-${safeActionId}`;
  }

  private createHeredocDelimiter(content: string, label: string): string {
    const safeLabel = this.safePathToken(label).toUpperCase();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const delimiter = `__INVOKER_${safeLabel}_${randomUUID().replace(/-/g, '')}_${attempt}__`;
      const pattern = new RegExp(`(^|\\n)${delimiter}(\\n|$)`);
      if (!pattern.test(content)) return delimiter;
    }
    throw new Error(`Unable to create heredoc delimiter for ${label}`);
  }

  private renderHeredocFile(pathExpression: string, content: string, label: string): string {
    const delimiter = this.createHeredocDelimiter(content, label);
    return `cat > ${pathExpression} <<'${delimiter}'
${content}${content.endsWith('\n') ? '' : '\n'}${delimiter}
`;
  }

  private remotePathNormalizeFunction(): string {
    return `normalize_remote_path() {
  local path="$1"
  if [[ "$path" == '~' ]]; then
    printf '%s\\n' "$HOME"
  elif [[ "\${path:0:2}" == '~/' ]]; then
    printf '%s/%s\\n' "$HOME" "\${path:2}"
  else
    printf '%s\\n' "$path"
  fi
}
`;
  }

  private buildRuntimeBootstrapScript(options: {
    executionId: string;
    actionId: string;
    workspacePath: string;
    payload: string;
    managed: boolean;
    envExports: string;
  }): string {
    const runner = this.buildRunnerScript();
    const payload = this.buildPayloadScript(options.payload);
    const provision = options.managed && this.provisionCommand?.trim()
      ? this.buildPayloadScript(this.provisionCommand)
      : undefined;
    const heartbeatMarker = this.shellQuote(SshExecutor.REMOTE_HEARTBEAT_MARKER);
    const heartbeatIntervalSeconds = this.remoteHeartbeatIntervalSeconds;
    const stagingTokenExpression = this.buildStagingDirExpression(options.executionId, options.actionId);
    const provisionPathDeclaration = provision ? `PROVISION_PATH="$STAGING_DIR/provision.sh"\n` : '';
    const provisionFile = provision ? this.renderHeredocFile('"$PROVISION_PATH"', provision, 'provision') : '';
    const provisionChmod = provision ? ' "$PROVISION_PATH"' : '';
    const provisionSection = provision
      ? `echo "[SshExecutor] Provisioning remote workspace..."
"$PROVISION_PATH"
`
      : '';
    const runPayloadSection = `echo "[SshExecutor] Running task payload..."
`;

    return `set -euo pipefail
${this.remotePathNormalizeFunction()}
INVOKER_HOME=$(normalize_remote_path ${this.shellQuote(this.remoteInvokerHome)})
STAGING_DIR="$INVOKER_HOME/runtime/ssh-executor/${stagingTokenExpression}"
RUNNER_PATH="$STAGING_DIR/runner.sh"
PAYLOAD_PATH="$STAGING_DIR/payload.sh"
${provisionPathDeclaration}
cleanup_runtime() {
  local status="$1"
  trap - EXIT HUP INT TERM
  stop_bootstrap_heartbeat
  rm -rf "$STAGING_DIR" >/dev/null 2>&1 || true
  exit "$status"
}
BOOTSTRAP_HEARTBEAT_PID=""
INVOKER_HEARTBEAT_MARKER=${heartbeatMarker}
INVOKER_HEARTBEAT_INTERVAL_SECONDS=${heartbeatIntervalSeconds}
start_bootstrap_heartbeat() {
  printf '%s %s\\n' "$INVOKER_HEARTBEAT_MARKER" "$(date +%s)"
  (
    while true; do
      sleep "$INVOKER_HEARTBEAT_INTERVAL_SECONDS"
      printf '%s %s\\n' "$INVOKER_HEARTBEAT_MARKER" "$(date +%s)"
    done
  ) &
  BOOTSTRAP_HEARTBEAT_PID=$!
}
stop_bootstrap_heartbeat() {
  if [ -n "\${BOOTSTRAP_HEARTBEAT_PID:-}" ]; then
    kill "$BOOTSTRAP_HEARTBEAT_PID" >/dev/null 2>&1 || true
    wait "$BOOTSTRAP_HEARTBEAT_PID" 2>/dev/null || true
    BOOTSTRAP_HEARTBEAT_PID=""
  fi
}
trap 'cleanup_runtime "$?"' EXIT
trap 'cleanup_runtime 129' HUP
trap 'cleanup_runtime 130' INT
trap 'cleanup_runtime 143' TERM
rm -rf "$STAGING_DIR" 2>/dev/null || true
mkdir -p "$STAGING_DIR"
chmod 700 "$STAGING_DIR"
${this.renderHeredocFile('"$RUNNER_PATH"', runner, 'runner')}${this.renderHeredocFile('"$PAYLOAD_PATH"', payload, 'payload')}${provisionFile}chmod 700 "$RUNNER_PATH" "$PAYLOAD_PATH"${provisionChmod}
WT=$(normalize_remote_path ${this.shellQuote(options.workspacePath)})
cd "$WT"
${options.envExports}
start_bootstrap_heartbeat
${provisionSection}${runPayloadSection}stop_bootstrap_heartbeat
"$RUNNER_PATH" "$PAYLOAD_PATH"
`;
  }

  private buildRemoteCommand(): string[] {
    if (!this.remotePath) return ['bash', '-s'];
    return ['env', `PATH=${this.remotePath}`, 'bash', '-s'];
  }

  private async execRemoteCapture(script: string, phase?: string): Promise<string> {
    const bench = createExecutionBench({
      module: 'ssh-executor-start-bench',
      baseMetadata: {
        host: this.host,
        user: this.user,
        remotePhase: phase ?? 'remote_capture',
      },
    });
    bench('SshExecutor.execRemoteCapture.begin');
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.buildSshArgs(), ...this.buildRemoteCommand()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanElectronEnv(),
      });
      bench('SshExecutor.execRemoteCapture.spawned');
      child.stdin.write(script);
      child.stdin.end();
      let out = '';
      let err = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('error', (error) => {
        bench('SshExecutor.execRemoteCapture.spawnError', { error: error.message });
        reject(error);
      });
      child.on('close', (code) => {
        bench('SshExecutor.execRemoteCapture.closed', {
          code,
          stdoutBytes: out.length,
          stderrBytes: err.length,
        });
        if (code === 0) resolve(out);
        else {
          reject(createSshRemoteScriptError(code, out, err, phase));
        }
      });
    });
  }

  protected override runBash(script: string, _cwd: string): Promise<string> {
    return this.execRemoteCapture(script);
  }

  async start(request: WorkRequest): Promise<ExecutorHandle> {
    const handle = this.createHandle(request);
    const executionId = handle.executionId;
    const bench = createExecutionBench({
      module: 'ssh-executor-start-bench',
      baseMetadata: {
        requestId: request.requestId,
        actionId: request.actionId,
        actionType: request.actionType,
        host: this.host,
        user: this.user,
        managedWorkspaces: this.managedWorkspaces,
      },
    });
    bench('SshExecutor.start.begin');

    if (request.actionType === 'reconciliation') {
      const entry: SshEntry = {
        process: null,
        request,
        outputListeners: new Set(),
        outputBuffer: [],
        outputBufferBytes: 0,
        evictedChunkCount: 0,
        completeListeners: new Set(),
        heartbeatListeners: new Set(),
        completed: false,
      };
      this.registerEntry(handle, entry);
      this.scheduleReconciliationResponse(executionId);
      bench('SshExecutor.start.reconciliation.returning');
      return handle;
    }

    try {
      bench('SshExecutor.sshKey.access.before', { sshKeyPath: this.sshKeyPath });
      accessSync(this.sshKeyPath, constants.R_OK);
      bench('SshExecutor.sshKey.access.after', { sshKeyPath: this.sshKeyPath });
    } catch {
      bench('SshExecutor.sshKey.access.failed', { sshKeyPath: this.sshKeyPath });
      throw new Error(
        `SSH key file not accessible: ${this.sshKeyPath}\n` +
        `Update "sshKeyPath" in your Invoker config (.invoker.json or ~/.invoker/config.json).`,
      );
    }

    let payload: string;
    let agentSessionId: string | undefined;
    const executionAgent = request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
    const effectiveAgentName = request.actionType === 'ai_task'
      ? (this.agentRegistry ? executionAgent : 'claude')
      : undefined;

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      payload = command;
      bench('SshExecutor.payload.built', { command: true });
    } else if (request.actionType === 'ai_task') {
      if (this.agentRegistry) {
        const agentName = request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
        const agent = this.agentRegistry.getOrThrow(agentName);
        assertExecutionModelSupported(agent, request.inputs.executionModel);
        const fullPrompt = this.buildFullPrompt(request);
        const spec = agent.buildCommand(fullPrompt, { executionModel: request.inputs.executionModel });
        agentSessionId = spec.sessionId;
        payload = `${spec.cmd} ${spec.args.map(a => this.shellQuote(a)).join(' ')}`;
        bench('SshExecutor.payload.built', {
          executionAgent,
          hasAgentSessionId: !!agentSessionId,
        });
      } else {
        const session = this.prepareClaudeSession(request);
        agentSessionId = session.sessionId;
        payload = `claude ${session.cliArgs.map(a => this.shellQuote(a)).join(' ')}`;
        bench('SshExecutor.payload.built', {
          executionAgent: 'claude',
          hasAgentSessionId: !!agentSessionId,
        });
      }
    } else {
      payload = 'echo "Unsupported action type"';
      bench('SshExecutor.payload.built', { unsupportedActionType: request.actionType });
    }

    try {
      if (this.managedWorkspaces) {
        const repoUrl = request.inputs.repoUrl;
        if (!repoUrl) {
          throw new Error(
            `SSH managed workspace task "${request.actionId}" requires repoUrl. ` +
            `Add a top-level "repoUrl" to your plan YAML (e.g. repoUrl: git@github.com:user/repo.git).`,
          );
        }
        bench('SshExecutor.startManagedWorkspace.before', { repoUrl });
        const started = await this.startManagedWorkspace(request, handle, repoUrl, payload, agentSessionId, effectiveAgentName);
        bench('SshExecutor.startManagedWorkspace.after', {
          workspacePath: started.workspacePath,
          branch: started.branch,
        });
        return started;
      } else {
        bench('SshExecutor.startBYOWorkspace.before');
        const started = await this.startBYOWorkspace(request, handle, payload, agentSessionId);
        bench('SshExecutor.startBYOWorkspace.after', {
          workspacePath: started.workspacePath,
          branch: started.branch,
        });
        return started;
      }
    } catch (err) {
      bench('SshExecutor.start.failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      throw this.withStartupMetadata(err, handle);
    }
  }

  /**
   * BYO (Bring Your Own) mode: user provides pre-cloned workspace path.
   * No clone, fetch, worktree, or provision operations. Simply run command in provided directory.
   */
  private async startBYOWorkspace(
    request: WorkRequest,
    handle: ExecutorHandle,
    payload: string,
    agentSessionId?: string,
  ): Promise<ExecutorHandle> {
    const bench = createExecutionBench({
      module: 'ssh-executor-start-bench',
      baseMetadata: {
        requestId: request.requestId,
        actionId: request.actionId,
        host: this.host,
        user: this.user,
      },
    });
    bench('SshExecutor.startBYOWorkspace.begin');
    const executionId = handle.executionId;
    const workspacePath = request.inputs.workspacePath;

    if (!workspacePath) {
      throw new Error(
        `SSH BYO mode task "${request.actionId}" requires workspacePath in task inputs. ` +
        `Either provide workspacePath, or enable managedWorkspaces in your SSH target config.`,
      );
    }

    handle.workspacePath = workspacePath;
    handle.agentSessionId = agentSessionId;
    bench('SshExecutor.startBYOWorkspace.workspaceResolved', {
      workspacePath,
      hasAgentSessionId: !!agentSessionId,
    });

    // No-command tasks complete immediately
    if (!request.inputs.command && !request.inputs.prompt) {
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        executionGeneration: request.executionGeneration,
        status: 'completed',
        outputs: { exitCode: 0 },
      };
      const entry: SshEntry = {
        process: null,
        request,
        outputListeners: new Set(),
        outputBuffer: [],
        outputBufferBytes: 0,
        evictedChunkCount: 0,
        completeListeners: new Set(),
        heartbeatListeners: new Set(),
        completed: true,
        agentSessionId,
      };
      this.registerEntry(handle, entry);
      this.emitComplete(executionId, response);
      bench('SshExecutor.startBYOWorkspace.noCommand.returning');
      return handle;
    }

    const envExports = buildRemoteAgentEnvExports(this.secretsFile, this.useApiKey);
    const runScript = this.buildRuntimeBootstrapScript({
      executionId,
      actionId: request.actionId,
      workspacePath,
      payload,
      managed: false,
      envExports,
    });

    bench('SshExecutor.startBYOWorkspace.spawnSshRemoteStdin.before', { workspacePath });
    const started = await this.spawnSshRemoteStdin(executionId, request, handle, runScript, agentSessionId, undefined);
    bench('SshExecutor.startBYOWorkspace.spawnSshRemoteStdin.after', { workspacePath });
    return started;
  }

  /**
   * Managed workspace mode: clone, fetch, create worktrees, provision, then execute.
   */
  private async startManagedWorkspace(
    request: WorkRequest,
    handle: ExecutorHandle,
    repoUrl: string,
    payload: string,
    agentSessionId?: string,
    effectiveAgentName?: string,
  ): Promise<ExecutorHandle> {
    const bench = createExecutionBench({
      module: 'ssh-executor-start-bench',
      baseMetadata: {
        requestId: request.requestId,
        actionId: request.actionId,
        host: this.host,
        user: this.user,
        repoUrl,
      },
    });
    bench('SshExecutor.startManagedWorkspace.begin');
    const executionId = handle.executionId;
    const h = computeRepoUrlHash(repoUrl);
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((x): x is string => !!x);
    const lifecycleTag = request.inputs.lifecycleTag ?? '';
    handle.agentSessionId = agentSessionId;

    // Use configured remoteInvokerHome (default ~/.invoker)
    const invokerHome = this.remoteInvokerHome;

    // Step 1: Clone/fetch on remote + resolve baseHead
    const script1 = buildMirrorCloneScript({
      repoUrl,
      branchRepoUrl: request.inputs.branchRepoUrl,
      repoHash: h,
      baseRef,
      invokerHome,
    });
    bench('SshExecutor.startManagedWorkspace.bootstrapCloneFetch.before', { baseRef });
    const bootstrapOut = await this.execRemoteCapture(script1, 'bootstrap_clone_fetch');
    const { resolvedBaseRef, baseHead, warning, fetchSuccess } = parseBootstrapOutput(bootstrapOut);
    bench('SshExecutor.startManagedWorkspace.bootstrapCloneFetch.after', {
      resolvedBaseRef,
      baseHead,
      fetchSuccess,
      hasWarning: !!warning,
    });
    if (warning) {
      this.emitOutput(executionId, `[SshExecutor] ${warning}\n`);
    }
    if (!fetchSuccess) {
      const msg = `[WARNING] Git fetch failed for remote mirror clone\n` +
        `[WARNING] Continuing with existing refs. Tasks may use stale commits.\n`;
      this.emitOutput(executionId, msg);
    }
    const contentHash = computeContentHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
    );
    const experimentBranch = buildExperimentBranchName(
      request.actionId,
      lifecycleTag,
      contentHash,
    );
    bench('SshExecutor.startManagedWorkspace.branchComputed', {
      experimentBranch,
      contentHash,
    });
    // Persist the branch on the attempt row before we run any remote git
    // command that could leak a worktree without a recorded branch.
    try {
      request.onBranchResolved?.(experimentBranch);
      bench('SshExecutor.startManagedWorkspace.onBranchResolved.done', { experimentBranch });
    } catch {
      bench('SshExecutor.startManagedWorkspace.onBranchResolved.failed', { experimentBranch });
      // Best-effort; the post-start path persists this again.
    }
    const san = sanitizeBranchForPath(experimentBranch);
    const remoteClone = `${invokerHome}/repos/${h}`;
    const canonicalRemoteWt = `${invokerHome}/worktrees/${h}/${san}`;

    // Set branch metadata immediately, but do not treat the canonical worktree
    // path as real until Git has actually created or confirmed it.
    handle.branch = experimentBranch;

    bench('SshExecutor.startManagedWorkspace.detectHome.before');
    const remoteHome = (await this.execRemoteCapture('printf %s "$HOME"', 'detect_home')).trim();
    bench('SshExecutor.startManagedWorkspace.detectHome.after', { remoteHome });
    const porcelainScript = buildWorktreeListScript({ repoHash: h, invokerHome });
    bench('SshExecutor.startManagedWorkspace.listWorktrees.before');
    const porcelain = await this.execRemoteCapture(porcelainScript, 'list_worktrees');
    bench('SshExecutor.startManagedWorkspace.listWorktrees.after', { bytes: porcelain.length });

    // Expand ~ in invokerHome for path matching
    const expandedInvokerHome = invokerHome === '~'
      ? remoteHome
      : invokerHome.startsWith('~/')
      ? remoteHome + invokerHome.slice(1)
      : invokerHome;
    const managedPrefix = normalize(`${expandedInvokerHome}/worktrees/${h}`);
    const reuseAbs = findManagedWorktreeForBranch(porcelain, experimentBranch, [managedPrefix]);
    let exactBranchCandidate:
      | { path: string; headMatchesTargetBranch: boolean }
      | undefined;
    if (reuseAbs) {
      const headScript = buildWorktreeHeadScript(reuseAbs);
      try {
        bench('SshExecutor.startManagedWorkspace.inspectReuseHead.before', { reuseAbs });
        const head = (await this.execRemoteCapture(headScript)).trim();
        exactBranchCandidate = {
          path: reuseAbs,
          headMatchesTargetBranch: abbrevRefMatchesBranch(head, experimentBranch),
        };
        bench('SshExecutor.startManagedWorkspace.inspectReuseHead.after', {
          reuseAbs,
          head,
          headMatchesTargetBranch: exactBranchCandidate.headMatchesTargetBranch,
        });
      } catch {
        exactBranchCandidate = undefined;
        bench('SshExecutor.startManagedWorkspace.inspectReuseHead.failed', { reuseAbs });
      }
    }

    bench('SshExecutor.startManagedWorkspace.planManagedWorktree.before');
    const worktreePlan = planManagedWorktree({
      targetBranch: experimentBranch,
      targetWorktreePath: canonicalRemoteWt,
      forceFresh: request.inputs.freshWorkspace === true,
      exactBranchCandidate,
    });
    bench('SshExecutor.startManagedWorkspace.planManagedWorktree.after', { planKind: worktreePlan.kind });

    let remoteWt = canonicalRemoteWt;
    let skippedRemotePreserve = false;

    switch (worktreePlan.kind) {
      case 'reuse_exact':
        skippedRemotePreserve = true;
        remoteWt = worktreePlan.worktreePath;
        handle.workspacePath =
          remoteWt.startsWith(`${remoteHome}/`) ? `~${remoteWt.slice(remoteHome.length)}` : remoteWt;
        break;
      case 'rename_reuse':
        throw new Error('SSH managed workspaces do not support same-task different-branch rename reuse');
      case 'recreate': {
        // Workspace cleanup is gated by INVOKER_ENABLE_WORKSPACE_CLEANUP. With
        // attemptId mixed into the branch hash, the canonical worktree path
        // for the new attempt has never existed, so cleanup is unnecessary
        // for correctness. Re-enable the env flag if you need disk hygiene.
        if (isWorkspaceCleanupEnabled()) {
          const cleanupScript = buildWorktreeCleanupScript({
            remoteClone,
            worktreePaths: worktreePlan.cleanupPaths,
          });
          bench('SshExecutor.startManagedWorkspace.cleanupWorktree.before', {
            cleanupCount: worktreePlan.cleanupPaths.length,
          });
          await this.execRemoteCapture(cleanupScript, 'cleanup_worktree');
          bench('SshExecutor.startManagedWorkspace.cleanupWorktree.after', {
            cleanupCount: worktreePlan.cleanupPaths.length,
          });
        }
        remoteWt = canonicalRemoteWt;
        break;
      }
    }

    if (skippedRemotePreserve) {
      bench('SshExecutor.startManagedWorkspace.sandboxReset.before', { remoteWt });
      await this.execRemoteCapture(
        buildWorktreeSandboxResetScript({ worktreePath: remoteWt, toRef: resolvedBaseRef }),
        'sandbox_reset',
      );
      bench('SshExecutor.startManagedWorkspace.sandboxReset.after', { remoteWt });
      bench('SshExecutor.startManagedWorkspace.mergeRequestUpstreamBranches.before', { remoteWt });
      await this.mergeRequestUpstreamBranches(request, remoteWt, resolvedBaseRef);
      bench('SshExecutor.startManagedWorkspace.mergeRequestUpstreamBranches.after', { remoteWt });
    } else {
      try {
        bench('SshExecutor.startManagedWorkspace.setupTaskBranch.before', {
          branchName: experimentBranch,
          base: resolvedBaseRef,
          remoteWt,
        });
        await this.setupTaskBranch(remoteClone, request, handle, {
          branchName: experimentBranch,
          base: resolvedBaseRef,
          worktreeDir: remoteWt,
        });
        bench('SshExecutor.startManagedWorkspace.setupTaskBranch.after', {
          branchName: experimentBranch,
          remoteWt,
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (!(wrapped as any).phase) (wrapped as any).phase = 'setup_branch';
        bench('SshExecutor.startManagedWorkspace.setupTaskBranch.failed', {
          error: wrapped.message,
          remoteWt,
        });
        throw wrapped;
      }
      handle.workspacePath =
        remoteWt.startsWith(`${remoteHome}/`) ? `~${remoteWt.slice(remoteHome.length)}` : remoteWt;
    }

    // Step 4: No-command tasks complete immediately
    if (!request.inputs.command && !request.inputs.prompt) {
      await this.handleProcessExit(executionId, request, remoteWt, 0, {
        branch: experimentBranch,
        agentName: effectiveAgentName,
      });
      bench('SshExecutor.startManagedWorkspace.noCommand.returning', { remoteWt });
      return handle;
    }

    // Step 5: Provision + run payload in a single SSH session
    const envExports = buildRemoteAgentEnvExports(this.secretsFile, this.useApiKey);
    const runScript = this.buildRuntimeBootstrapScript({
      executionId,
      actionId: request.actionId,
      workspacePath: remoteWt,
      payload,
      managed: true,
      envExports,
    });

    bench('SshExecutor.startManagedWorkspace.spawnSshRemoteStdin.before', {
      remoteWt,
      workspacePath: handle.workspacePath,
      branch: experimentBranch,
    });
    const started = await this.spawnSshRemoteStdin(executionId, request, handle, runScript, agentSessionId, {
      worktreePath: handle.workspacePath!,
      branch: experimentBranch,
    }, effectiveAgentName);
    bench('SshExecutor.startManagedWorkspace.spawnSshRemoteStdin.after', {
      remoteWt,
      workspacePath: started.workspacePath,
      branch: started.branch,
    });
    return started;
  }

  private withStartupMetadata(err: unknown, handle: ExecutorHandle): Error {
    const wrapped = err instanceof Error ? err : new Error(String(err));
    const ownerPath = parseOwnedWorktreePath(`${(wrapped as any).stderr ?? ''}\n${wrapped.message}`);
    if (ownerPath) {
      (wrapped as any).workspacePath = ownerPath;
    } else if (handle.workspacePath) {
      (wrapped as any).workspacePath = handle.workspacePath;
    }
    if (handle.branch) (wrapped as any).branch = handle.branch;
    if (handle.agentSessionId) (wrapped as any).agentSessionId = handle.agentSessionId;
    if (handle.containerId) (wrapped as any).containerId = handle.containerId;
    return wrapped;
  }

  private processOutputChunk(
    executionId: string,
    chunk: string,
    streamState: { remainder: string },
  ): void {
    const full = streamState.remainder + chunk;
    const lines = full.split('\n');
    streamState.remainder = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith(SshExecutor.REMOTE_HEARTBEAT_MARKER)) {
        const entry = this.entries.get(executionId);
        console.info(
          `[ssh-lifecycle] remote heartbeat marker executionId=${executionId} ` +
            `task=${entry?.request.actionId ?? 'unknown'} marker="${line}"`,
        );
        this.emitHeartbeat(executionId);
        continue;
      }
      this.emitOutput(executionId, `${line}\n`);
    }
  }

  private flushOutputRemainder(executionId: string, streamState: { remainder: string }): void {
    if (!streamState.remainder) return;
    if (streamState.remainder.startsWith(SshExecutor.REMOTE_HEARTBEAT_MARKER)) {
      const entry = this.entries.get(executionId);
      console.info(
        `[ssh-lifecycle] remote heartbeat marker executionId=${executionId} ` +
          `task=${entry?.request.actionId ?? 'unknown'} marker="${streamState.remainder}" source=remainder`,
      );
      this.emitHeartbeat(executionId);
    } else {
      this.emitOutput(executionId, streamState.remainder);
    }
    streamState.remainder = '';
  }

  private mapSshTransportError(
    exitCode: number,
    stderrOutput: string,
    bufferedOutput: string,
  ): string | undefined {
    if (exitCode !== 255) return undefined;
    const haystack = `${stderrOutput}\n${bufferedOutput}`.toLowerCase();
    if (haystack.includes('broken pipe')) {
      return 'SSH transport failed (exit 255): broken pipe while streaming remote task output.';
    }
    if (haystack.includes('connection timed out')) {
      return 'SSH transport failed (exit 255): connection timed out.';
    }
    if (haystack.includes('operation timed out')) {
      return 'SSH transport failed (exit 255): SSH operation timed out.';
    }
    if (haystack.includes('connection reset')) {
      return 'SSH transport failed (exit 255): connection reset by peer.';
    }
    return 'SSH transport failed (exit 255): remote session terminated unexpectedly.';
  }

  /**
   * On the remote host: commit task result (same semantics as local recordTaskResult) then push branch.
   * Returns commit hash on success; `error` if commit or push failed.
   */
  private async remoteGitRecordAndPush(
    _executionId: string,
    request: WorkRequest,
    worktreePath: string,
    branch: string,
    commandExitCode: number,
  ): Promise<{ commitHash?: string; error?: string }> {
    const msgChanges = this.buildCommitMessage(request);
    const msgEmpty = this.buildResultCommitMessage(request, commandExitCode);
    const gitUserName = process.env.GIT_AUTHOR_NAME ?? process.env.GIT_COMMITTER_NAME ?? 'Invoker Bot';
    const gitUserEmail = process.env.GIT_AUTHOR_EMAIL ?? process.env.GIT_COMMITTER_EMAIL ?? 'invoker@local';

    const recordScript = buildRecordAndPushScript({
      worktreePath,
      branch,
      commitMessageChanges: msgChanges,
      commitMessageEmpty: msgEmpty,
      gitUserName,
      gitUserEmail,
      pushRemoteUrl: request.inputs.branchRepoUrl?.trim() || undefined,
    });

    try {
      const stdout = await this.execRemoteCapture(recordScript);
      return parseRecordAndPushOutput(stdout, 0, '');
    } catch (err: any) {
      const exitCode = err.exitCode ?? 1;
      const stderr = err.stderr ?? err.message ?? '';
      const stdout = err.stdout ?? '';
      return parseRecordAndPushOutput(stdout, exitCode, stderr);
    }
  }

  async publishApprovedFix(
    worktreePath: string,
    request: WorkRequest,
    branch: string,
  ): Promise<{ commitHash?: string; error?: string }> {
    return this.remoteGitRecordAndPush('publish-approved-fix', request, worktreePath, branch, 0);
  }

  /** Run a bash script on the remote (fed to `bash -s` on stdin). */
  private spawnSshRemoteStdin(
    executionId: string,
    request: WorkRequest,
    handle: ExecutorHandle,
    bashScript: string,
    agentSessionId: string | undefined,
    finalizeRemote: { worktreePath: string; branch: string } | undefined,
    effectiveAgentName?: string,
  ): ExecutorHandle {
    const child = spawn('ssh', [...this.buildSshArgs(), ...this.buildRemoteCommand()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: cleanElectronEnv(),
    });
    console.info(
      `[ssh-lifecycle] spawned ssh session task=${request.actionId} executionId=${executionId} ` +
        `pid=${child.pid ?? 'unknown'} finalizeRemote=${finalizeRemote ? 'yes' : 'no'} ` +
        `workspace=${handle.workspacePath ?? 'none'} branch=${handle.branch ?? 'none'}`,
    );
    child.stdin?.write(bashScript);
    child.stdin?.end();

    const entry: SshEntry = {
      process: child,
      request,
      outputListeners: new Set(),
      outputBuffer: [],
      outputBufferBytes: 0,
      evictedChunkCount: 0,
      completeListeners: new Set(),
      heartbeatListeners: new Set(),
      completed: false,
      agentSessionId,
    };

    this.registerEntry(handle, entry);
    console.info(
      `[ssh-lifecycle] registered entry task=${request.actionId} executionId=${executionId} ` +
        `pid=${child.pid ?? 'unknown'} entries=${this.entries.size}`,
    );

    child.on('error', (err) => {
      console.info(
        `[ssh-lifecycle] child error task=${request.actionId} executionId=${executionId} ` +
          `pid=${child.pid ?? 'unknown'} error=${err.message}`,
      );
      const e = this.entries.get(executionId);
      if (e) e.completed = true;
      const response: WorkResponse = {
        requestId: request.requestId,
        actionId: request.actionId,
        executionGeneration: request.executionGeneration,
        status: 'failed',
        outputs: {
          exitCode: 1,
          error: `SSH spawn failed: ${err.message}`,
        },
      };
      this.emitComplete(executionId, response);
    });
    if (agentSessionId) {
      handle.agentSessionId = agentSessionId;
    }

    let stderrOutput = '';
    const stdoutState = { remainder: '' };
    const stderrState = { remainder: '' };

    child.stdout?.on('data', (chunk: Buffer) => {
      this.processOutputChunk(executionId, chunk.toString(), stdoutState);
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderrOutput += text;
      this.processOutputChunk(executionId, text, stderrState);
    });

    child.on('close', (code, signal) => {
      console.info(
        `[ssh-lifecycle] child close task=${request.actionId} executionId=${executionId} ` +
          `pid=${child.pid ?? 'unknown'} code=${code ?? 'null'} signal=${signal ?? 'none'} ` +
          `stderrBytes=${stderrOutput.length}`,
      );
      void (async () => {
        this.flushOutputRemainder(executionId, stdoutState);
        this.flushOutputRemainder(executionId, stderrState);
        const exitCode = code ?? (signal ? 1 : 0);
        const e = this.entries.get(executionId);
        if (e) e.finalizingAfterClose = true;
        try {
          let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
          let mappedError: string | undefined;
          const output = e?.outputBuffer.join('') ?? '';
          if (exitCode === 30) {
            mappedError = 'Upstream branch missing on remote clone';
          } else if (exitCode === 31) {
            const branchMatch = output.match(/MERGE_CONFLICT_BRANCH=(.+)/);
            const filesSection = output.match(/MERGE_CONFLICT_FILES:\n([\s\S]*?)(?:\n\[Ssh|$)/);
            const branch = branchMatch?.[1]?.trim() ?? 'unknown';
            const files = filesSection?.[1]?.trim() ?? '(see task output)';
            mappedError = `Merge conflict merging upstream branch "${branch}" on remote.\nConflicting files:\n${files}`;
          } else {
            mappedError = this.mapSshTransportError(exitCode, stderrOutput, output);
          }

          let commitHash: string | undefined;

          if (finalizeRemote) {
            console.info(
              `[ssh-lifecycle] remote finalize begin task=${request.actionId} executionId=${executionId} ` +
                `worktree=${finalizeRemote.worktreePath} branch=${finalizeRemote.branch} exitCode=${exitCode}`,
            );
            this.emitOutput(executionId, '[SshExecutor] Recording task result and pushing branch on remote...\n');
            const fin = await this.remoteGitRecordAndPush(
              executionId,
              request,
              finalizeRemote.worktreePath,
              finalizeRemote.branch,
              exitCode,
            );
            if (fin.commitHash) commitHash = fin.commitHash;
            if (fin.error) {
              this.emitOutput(executionId, `[SshExecutor] ${fin.error}\n`);
              if (exitCode === 0) status = 'failed';
              mappedError = fin.error;
            }
            console.info(
              `[ssh-lifecycle] remote finalize end task=${request.actionId} executionId=${executionId} ` +
                `commitHash=${commitHash ?? 'none'} error=${fin.error ?? 'none'}`,
            );
          }

          // When the command fails but no specific error was mapped (exit 30/31),
          // capture the tail of the output buffer so the UI shows what went wrong.
          if (!mappedError && exitCode !== 0 && e) {
            const allOutput = e.outputBuffer.join('');
            const lines = allOutput.split('\n');
            const tail = lines.slice(-50).join('\n').trim();
            if (tail) {
              mappedError = tail.length > 3000 ? tail.slice(-3000) : tail;
            }
          }

          // Replace local UUID with real backend session/thread ID for resume,
          // then store session locally via driver (matches worktree-executor pattern).
          if (entry.agentSessionId && this.agentRegistry) {
            const agentName = request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
            const driver = this.agentRegistry.getSessionDriver(agentName);
            const rawOutput = e?.outputBuffer.join('') ?? '';
            const realId = driver?.extractSessionId?.(rawOutput);
            if (realId) {
              entry.agentSessionId = realId;
            }
            if (driver) {
              driver.processOutput(entry.agentSessionId!, rawOutput);
            }
          }

          const finalExitCode = status === 'failed' && exitCode === 0 ? 1 : exitCode;
          const response: WorkResponse = {
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status,
            outputs: {
              exitCode: finalExitCode,
              commitHash,
              agentSessionId: entry.agentSessionId,
              agentName: effectiveAgentName,
              ...(mappedError ? { error: mappedError } : {}),
              ...(finalizeRemote && commitHash
                ? { summary: `branch=${finalizeRemote.branch} commit=${commitHash}` }
                : {}),
            },
          };
          if (e) e.finalizingAfterClose = false;
          console.info(
            `[ssh-lifecycle] emit complete task=${request.actionId} executionId=${executionId} ` +
              `status=${status} exitCode=${finalExitCode} commitHash=${commitHash ?? 'none'} ` +
              `agentSessionId=${entry.agentSessionId ?? 'none'}`,
          );
          this.emitComplete(executionId, response);
        } catch (err) {
          if (e) e.finalizingAfterClose = false;
          console.info(
            `[ssh-lifecycle] completion failure task=${request.actionId} executionId=${executionId} ` +
              `error=${err instanceof Error ? err.message : String(err)}`,
          );
          const response: WorkResponse = {
            requestId: request.requestId,
            actionId: request.actionId,
            executionGeneration: request.executionGeneration,
            status: 'failed',
            outputs: {
              exitCode: exitCode === 0 ? 1 : exitCode,
              agentSessionId: entry.agentSessionId,
              error: err instanceof Error ? (err.stack ?? err.message) : String(err),
            },
          };
          this.emitComplete(executionId, response);
        }
      })();
    });

    this.startHeartbeat(executionId, child, { emitIntervalHeartbeat: false });
    return handle;
  }


  sendInput(handle: ExecutorHandle, input: string): void {
    const entry = this.entries.get(handle.executionId);
    if (!entry || entry.completed) return;
    entry.process?.stdin?.write(input);
  }

  getTerminalSpec(handle: ExecutorHandle): TerminalSpec | null {
    const entry = this.entries.get(handle.executionId);
    if (!entry) return null;
    if (handle.workspacePath) {
      const base = this.buildSshArgsInteractive();
      const userAtHost = base[base.length - 1]!;
      const opts = base.slice(0, -1);
      const executionAgent = entry.request.inputs.executionAgent ?? DEFAULT_EXECUTION_AGENT;
      const inner = this.buildRemoteTerminalInner(handle.workspacePath, handle.branch, entry.agentSessionId, executionAgent);
      return {
        command: 'ssh',
        args: [...opts, '-t', userAtHost, inner],
      };
    }
    return {
      command: 'ssh',
      args: this.buildSshArgs(),
    };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    console.log(`[SshExecutor] getRestoredTerminalSpec: meta=${JSON.stringify(meta)}`);
    // meta.executionAgent missing
    const isRemotePath = meta.workspacePath?.startsWith('~') || meta.workspacePath?.startsWith('/home/' + this.user + '/');
    if (meta.workspacePath && isRemotePath) {
      const base = this.buildSshArgsInteractive();
      const userAtHost = base[base.length - 1]!;
      const opts = base.slice(0, -1);
      const inner = this.buildRemoteTerminalInner(meta.workspacePath, meta.branch, meta.agentSessionId, meta.executionAgent);
      return {
        command: 'ssh',
        args: [...opts, '-t', userAtHost, inner],
      };
    }
    if (meta.agentSessionId || meta.branch) {
      const base = this.buildSshArgsInteractive();
      const userAtHost = base[base.length - 1]!;
      const opts = base.slice(0, -1);
      const inner = this.buildRemoteTerminalInner('~', meta.branch, meta.agentSessionId, meta.executionAgent);
      return {
        command: 'ssh',
        args: [...opts, '-t', userAtHost, inner],
      };
    }
    return {
      command: 'ssh',
      args: this.buildSshArgs(),
    };
  }

  private buildRemoteTerminalInner(workspacePath: string, branch?: string, agentSessionId?: string, executionAgent?: string): string {
    const cdPart = sshInteractiveCdFragment(workspacePath);
    console.log(`[SshExecutor] Building remote terminal inner command. workspacePath=${workspacePath} branch=${branch} agentSessionId=${agentSessionId} executionAgent=${executionAgent}`);
    if (agentSessionId) {
      let resumeCmd: string;
      if (this.agentRegistry) {
        const resume = this.agentRegistry.getOrThrow(executionAgent ?? DEFAULT_EXECUTION_AGENT).buildResumeArgs(agentSessionId);
        resumeCmd = [resume.cmd, ...resume.args.map(a => sshGitShellQuote(a))].join(' ');
      } else {
        resumeCmd = `claude --resume ${sshGitShellQuote(agentSessionId)} --dangerously-skip-permissions`;
      }
      return branch
        ? `${cdPart} && git checkout ${sshGitShellQuote(branch)} 2>/dev/null; ${resumeCmd}`
        : `${cdPart} && ${resumeCmd}`;
    }
    return branch
      ? `${cdPart} && git checkout ${sshGitShellQuote(branch)} 2>/dev/null; exec bash -l`
      : `${cdPart} && exec bash -l`;
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
