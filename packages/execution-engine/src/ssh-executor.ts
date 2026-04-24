import { spawn, type ChildProcess } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { normalize } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle, PersistedTaskMeta, TerminalSpec } from './executor.js';
import { BaseExecutor, type BaseEntry } from './base-executor.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { computeBranchHash } from './branch-utils.js';
import { planManagedWorktree } from './managed-worktree-controller.js';
import { findManagedWorktreeForBranch, abbrevRefMatchesBranch } from './worktree-discovery.js';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from './default-worktree-provision-command.js';
import type { AgentRegistry } from './agent-registry.js';
import { computeRepoUrlHash, sanitizeBranchForPath } from './git-utils.js';
import { isWorkspaceCleanupEnabled } from './workspace-cleanup-policy.js';
import {
  shellPosixSingleQuote as sshGitShellQuote,
  base64Encode as sshGitB64,
  sshInteractiveCdFragment,
  buildMirrorCloneScript,
  parseBootstrapOutput,
  buildWorktreeListScript,
  buildWorktreeHeadScript,
  buildWorktreeCleanupScript,
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
   * and provision per-task workspaces. When false (default), BYO mode: user provides
   * pre-cloned repo path and handles all git/setup operations.
   */
  managedWorkspaces?: boolean;
  /**
   * Remote invoker home directory (e.g., ~/.invoker). Only used in managed mode.
   * Default: ~/.invoker
   */
  remoteInvokerHome?: string;
  /**
   * Optional provision command to run in the worktree after creation (e.g., pnpm install).
   * Only used in managed mode. Default: pnpm install --frozen-lockfile
   */
  provisionCommand?: string;
}

interface SshEntry extends BaseEntry {
  process: ChildProcess | null;
  agentSessionId?: string;
}

/**
 * Executor that executes tasks on a remote machine via SSH key-based auth.
 *
 * Requires `repoUrl` on the work request. Clones / worktrees on the remote
 * under ~/.invoker (mirroring local RepoPool layout), provisions with the same
 * command as WorktreeExecutor, then runs the task (command or Claude) in that
 * directory. Always produces a branch and commits on completion.
 */
export class SshExecutor extends BaseExecutor<SshEntry> {
  readonly type = 'ssh';

  private readonly host: string;
  private readonly user: string;
  private readonly sshKeyPath: string;
  private readonly port: number;
  private readonly agentRegistry?: AgentRegistry;
  private readonly managedWorkspaces: boolean;
  private readonly remoteInvokerHome: string;
  private readonly provisionCommand: string;
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
    this.provisionCommand = config.provisionCommand ?? DEFAULT_WORKTREE_PROVISION_COMMAND;
    this.remotePath = process.env.PATH ?? '';
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

  /** SSH args without `BatchMode` so `-t` / interactive sessions work for external Terminal.app. */
  private buildSshArgsInteractive(): string[] {
    return [
      '-i', this.sshKeyPath,
      '-p', String(this.port),
      '-o', 'StrictHostKeyChecking=accept-new',
      `${this.user}@${this.host}`,
    ];
  }

  private buildRemoteCommand(): string[] {
    if (!this.remotePath) return ['bash', '-s'];
    return ['env', `PATH=${this.remotePath}`, 'bash', '-s'];
  }

  private async execRemoteCapture(script: string, phase?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.buildSshArgs(), ...this.buildRemoteCommand()], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: cleanElectronEnv(),
      });
      child.stdin.write(script);
      child.stdin.end();
      let out = '';
      let err = '';
      child.stdout?.on('data', (c: Buffer) => { out += c.toString(); });
      child.stderr?.on('data', (c: Buffer) => { err += c.toString(); });
      child.on('error', reject);
      child.on('close', (code) => {
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
      return handle;
    }

    try {
      accessSync(this.sshKeyPath, constants.R_OK);
    } catch {
      throw new Error(
        `SSH key file not accessible: ${this.sshKeyPath}\n` +
        `Update "sshKeyPath" in your Invoker config (.invoker.json or ~/.invoker/config.json).`,
      );
    }

    let payload: string;
    let agentSessionId: string | undefined;

    if (request.actionType === 'command') {
      const command = request.inputs.command;
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      payload = command;
    } else if (request.actionType === 'ai_task') {
      if (this.agentRegistry) {
        const requestedAgent = request.inputs.executionAgent ?? 'claude';
        const agent = this.agentRegistry.getOrThrow(requestedAgent);
        const fullPrompt = this.buildFullPrompt(request);
        const spec = agent.buildCommand(fullPrompt);
        agentSessionId = spec.sessionId;
        payload = `${spec.cmd} ${spec.args.map(a => this.shellQuote(a)).join(' ')}`;
      } else {
        const session = this.prepareClaudeSession(request);
        agentSessionId = session.sessionId;
        payload = `claude ${session.cliArgs.map(a => this.shellQuote(a)).join(' ')}`;
      }
    } else {
      payload = 'echo "Unsupported action type"';
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
        return await this.startManagedWorkspace(request, handle, repoUrl, payload, agentSessionId);
      } else {
        return await this.startBYOWorkspace(request, handle, payload, agentSessionId);
      }
    } catch (err) {
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
      return handle;
    }

    // Run payload in user-provided directory
    const payloadB64 = sshGitB64(payload);
    const wtB64 = sshGitB64(workspacePath);
    const runScript = `set -euo pipefail
WT=$(echo ${wtB64} | base64 -d)
if [[ "$WT" == '~' ]]; then
  WT="$HOME"
elif [[ "\${WT:0:2}" == '~/' ]]; then
  WT="$HOME/\${WT:2}"
fi
cd "$WT"
echo "[SshExecutor BYO] Running task in user-provided workspace: $WT"
echo ${payloadB64} | base64 -d | bash -se
`;

    return this.spawnSshRemoteStdin(executionId, request, handle, runScript, agentSessionId, undefined);
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
  ): Promise<ExecutorHandle> {
    const executionId = handle.executionId;
    const h = computeRepoUrlHash(repoUrl);
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((x): x is string => !!x);
    const salt = request.inputs.salt ?? '';
    handle.agentSessionId = agentSessionId;

    // Use configured remoteInvokerHome (default ~/.invoker)
    const invokerHome = this.remoteInvokerHome;

    // Step 1: Clone/fetch on remote + resolve baseHead
    const script1 = buildMirrorCloneScript({
      repoUrl,
      repoHash: h,
      baseRef,
      invokerHome,
    });
    const bootstrapOut = await this.execRemoteCapture(script1, 'bootstrap_clone_fetch');
    const { resolvedBaseRef, baseHead, warning, fetchSuccess } = parseBootstrapOutput(bootstrapOut);
    if (warning) {
      this.emitOutput(executionId, `[SshExecutor] ${warning}\n`);
    }
    if (!fetchSuccess) {
      const msg = `[WARNING] Git fetch failed for remote mirror clone\n` +
        `[WARNING] Continuing with existing refs. Tasks may use stale commits.\n`;
      this.emitOutput(executionId, msg);
    }
    const hash8 = computeBranchHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
      salt,
    );
    const experimentBranch = `experiment/${request.actionId}-${hash8}`;
    const san = sanitizeBranchForPath(experimentBranch);
    const remoteClone = `${invokerHome}/repos/${h}`;
    const canonicalRemoteWt = `${invokerHome}/worktrees/${h}/${san}`;

    // Set branch metadata immediately, but do not treat the canonical worktree
    // path as real until Git has actually created or confirmed it.
    handle.branch = experimentBranch;

    const remoteHome = (await this.execRemoteCapture('printf %s "$HOME"', 'detect_home')).trim();
    const porcelainScript = buildWorktreeListScript({ repoHash: h, invokerHome });
    const porcelain = await this.execRemoteCapture(porcelainScript, 'list_worktrees');

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
        const head = (await this.execRemoteCapture(headScript)).trim();
        exactBranchCandidate = {
          path: reuseAbs,
          headMatchesTargetBranch: abbrevRefMatchesBranch(head, experimentBranch),
        };
      } catch {
        exactBranchCandidate = undefined;
      }
    }

    const worktreePlan = planManagedWorktree({
      targetBranch: experimentBranch,
      targetWorktreePath: canonicalRemoteWt,
      forceFresh: request.inputs.freshWorkspace === true,
      exactBranchCandidate,
    });

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
          await this.execRemoteCapture(cleanupScript, 'cleanup_worktree');
        }
        remoteWt = canonicalRemoteWt;
        break;
      }
    }

    if (skippedRemotePreserve) {
      await this.mergeRequestUpstreamBranches(request, remoteWt, resolvedBaseRef);
    } else {
      try {
        await this.setupTaskBranch(remoteClone, request, handle, {
          branchName: experimentBranch,
          base: resolvedBaseRef,
          worktreeDir: remoteWt,
        });
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        if (!(wrapped as any).phase) (wrapped as any).phase = 'setup_branch';
        throw wrapped;
      }
      handle.workspacePath =
        remoteWt.startsWith(`${remoteHome}/`) ? `~${remoteWt.slice(remoteHome.length)}` : remoteWt;
    }

    // Step 4: No-command tasks complete immediately
    if (!request.inputs.command && !request.inputs.prompt) {
      await this.handleProcessExit(executionId, request, remoteWt, 0, {
        branch: experimentBranch,
      });
      return handle;
    }

    // Step 5: Provision + run payload in a single SSH session
    const provB64 = sshGitB64(this.provisionCommand);
    const payloadB64 = sshGitB64(payload);
    const wtB64 = sshGitB64(remoteWt);
    const runScript = `set -euo pipefail
WT=$(echo ${wtB64} | base64 -d)
if [[ "$WT" == '~' ]]; then
  WT="$HOME"
elif [[ "\${WT:0:2}" == '~/' ]]; then
  WT="$HOME/\${WT:2}"
fi
cd "$WT"
echo "[SshExecutor] Provisioning remote worktree with: ${this.provisionCommand.slice(0, 50)}..."
eval "$(echo ${provB64} | base64 -d)"
echo "[SshExecutor] Running task payload..."
echo ${payloadB64} | base64 -d | bash -se
`;

    return this.spawnSshRemoteStdin(executionId, request, handle, runScript, agentSessionId, {
      worktreePath: handle.workspacePath!,
      branch: experimentBranch,
    });
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

    const recordScript = buildRecordAndPushScript({
      worktreePath,
      branch,
      commitMessageChanges: msgChanges,
      commitMessageEmpty: msgEmpty,
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
  ): ExecutorHandle {
    const child = spawn('ssh', [...this.buildSshArgs(), ...this.buildRemoteCommand()], {
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: cleanElectronEnv(),
    });
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

    child.on('error', (err) => {
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

    child.stdout?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.stderr?.on('data', (chunk: Buffer) => {
      this.emitOutput(executionId, chunk.toString());
    });

    child.on('close', (code, signal) => {
      void (async () => {
        const exitCode = code ?? (signal ? 1 : 0);
        const e = this.entries.get(executionId);
        if (e) e.completed = true;

        let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
        let mappedError: string | undefined;
        if (exitCode === 30) {
          mappedError = 'Upstream branch missing on remote clone';
        } else if (exitCode === 31) {
          const output = e?.outputBuffer.join('') ?? '';
          const branchMatch = output.match(/MERGE_CONFLICT_BRANCH=(.+)/);
          const filesSection = output.match(/MERGE_CONFLICT_FILES:\n([\s\S]*?)(?:\n\[Ssh|$)/);
          const branch = branchMatch?.[1]?.trim() ?? 'unknown';
          const files = filesSection?.[1]?.trim() ?? '(see task output)';
          mappedError = `Merge conflict merging upstream branch "${branch}" on remote.\nConflicting files:\n${files}`;
        }

        let commitHash: string | undefined;

        if (finalizeRemote) {
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
          const agentName = request.inputs.executionAgent ?? 'claude';
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
            ...(mappedError ? { error: mappedError } : {}),
            ...(finalizeRemote && commitHash
              ? { summary: `branch=${finalizeRemote.branch} commit=${commitHash}` }
              : {}),
          },
        };
        this.emitComplete(executionId, response);
      })();
    });

    this.startHeartbeat(executionId, child);
    return handle;
  }

  async kill(handle: ExecutorHandle): Promise<void> {
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
      const executionAgent = entry.request.inputs.executionAgent ?? 'claude';
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
        const resume = this.agentRegistry.getOrThrow(executionAgent ?? 'claude').buildResumeArgs(agentSessionId);
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
