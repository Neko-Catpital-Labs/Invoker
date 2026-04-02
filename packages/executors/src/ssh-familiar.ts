import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, constants } from 'node:fs';
import { normalize } from 'node:path';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { computeBranchHash } from './branch-utils.js';
import { findManagedWorktreeForBranch, abbrevRefMatchesBranch } from './worktree-discovery.js';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from './default-worktree-provision-command.js';
import type { AgentRegistry } from './agent-registry.js';

export interface SshFamiliarConfig {
  host: string;
  user: string;
  /** Path to SSH identity file (private key). */
  sshKeyPath: string;
  /** SSH port. Default: 22. */
  port?: number;
  /** Agent registry for pluggable agent command building. */
  agentRegistry?: AgentRegistry;
}

interface SshEntry extends BaseEntry {
  process: ChildProcess | null;
  agentSessionId?: string;
}

/**
 * Familiar that executes tasks on a remote machine via SSH key-based auth.
 *
 * Requires `repoUrl` on the work request. Clones / worktrees on the remote
 * under ~/.invoker (mirroring local RepoPool layout), provisions with the same
 * command as WorktreeFamiliar, then runs the task (command or Claude) in that
 * directory. Always produces a branch and commits on completion.
 */
export class SshFamiliar extends BaseFamiliar<SshEntry> {
  readonly type = 'ssh';

  private readonly host: string;
  private readonly user: string;
  private readonly sshKeyPath: string;
  private readonly port: number;
  private readonly agentRegistry?: AgentRegistry;

  constructor(config: SshFamiliarConfig) {
    super();
    this.host = config.host;
    this.user = config.user;
    this.sshKeyPath = config.sshKeyPath;
    this.port = config.port ?? 22;
    this.agentRegistry = config.agentRegistry;
  }

  private static urlHash(repoUrl: string): string {
    return createHash('sha256').update(repoUrl).digest('hex').slice(0, 12);
  }

  private static b64(s: string): string {
    return Buffer.from(s, 'utf8').toString('base64');
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

  /** POSIX single-quote escaping for `bash -lc '…'` remote command lines. */
  private static shellPosixSingleQuote(s: string): string {
    return `'${s.replace(/'/g, `'\\''`)}'`;
  }

  /**
   * Bash fragment: after `WT=$(echo … | base64 -d)`.
   * Expands a leading ~ so `cd "$WT"` works. Do NOT use `case ~/*)` — bash tilde-expands
   * case patterns, so `~/*` becomes `/root/*` and never matches literal `~/.invoker/…`.
   */
  private static bashNormalizeWtFromDecodedVar(): string {
    return `if [[ "$WT" == '~' ]]; then
  WT="$HOME"
elif [[ "\${WT:0:2}" == '~/' ]]; then
  WT="$HOME/\${WT:2}"
fi`;
  }

  /** `bash -lc` inner fragment: cd into remote path; ~ must become $HOME (quotes prevent ~ expansion). */
  private static sshInteractiveCdFragment(workspacePath: string): string {
    if (workspacePath === '~') return 'cd "$HOME"';
    if (workspacePath.startsWith('~/')) {
      const rest = workspacePath.slice(2).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      return `cd "$HOME/${rest}"`;
    }
    return `cd ${SshFamiliar.shellPosixSingleQuote(workspacePath)}`;
  }

  private async execRemoteCapture(script: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', [...this.buildSshArgs(), 'bash', '-s'], {
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
          const error = new Error(`SSH remote script failed (${code}): ${err.trim() || out.trim()}`);
          (error as any).exitCode = code;
          (error as any).stderr = err;
          reject(error);
        }
      });
    });
  }

  protected override runBash(script: string, _cwd: string): Promise<string> {
    return this.execRemoteCapture(script);
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

    try {
      accessSync(this.sshKeyPath, constants.R_OK);
    } catch {
      throw new Error(
        `SSH key file not accessible: ${this.sshKeyPath}\n` +
        `Update "sshKeyPath" in your Invoker config (.invoker.json or ~/.invoker/config.json).`,
      );
    }

    const repoUrl = request.inputs.repoUrl;
    if (!repoUrl) {
      throw new Error(
        `SSH task "${request.actionId}" requires repoUrl. ` +
        `Add a top-level "repoUrl" to your plan YAML (e.g. repoUrl: git@github.com:user/repo.git).`,
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

    return this.startRemoteWorktree(request, handle, repoUrl, payload, agentSessionId);
  }

  private async startRemoteWorktree(
    request: WorkRequest,
    handle: FamiliarHandle,
    repoUrl: string,
    payload: string,
    agentSessionId?: string,
  ): Promise<FamiliarHandle> {
    const executionId = handle.executionId;
    const h = SshFamiliar.urlHash(repoUrl);
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((x): x is string => !!x);
    const salt = request.inputs.salt ?? '';

    // Step 1: Clone/fetch on remote + resolve baseHead
    const script1 = `set -euo pipefail
REPO=$(echo ${SshFamiliar.b64(repoUrl)} | base64 -d)
BASE=$(echo ${SshFamiliar.b64(baseRef)} | base64 -d)
H="${h}"
CLONE="$HOME/.invoker/repos/$H"
mkdir -p "$(dirname "$CLONE")"
if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi
git -C "$CLONE" fetch --all --prune || true
git -C "$CLONE" rev-parse "$BASE"
`;
    const baseHead = (await this.execRemoteCapture(script1)).trim();
    const hash8 = computeBranchHash(
      request.actionId,
      request.inputs.command,
      request.inputs.prompt,
      upstreamCommits,
      baseHead,
      salt,
    );
    const experimentBranch = `experiment/${request.actionId}-${hash8}`;
    const san = experimentBranch.replace(/\//g, '-');
    const remoteClone = `$HOME/.invoker/repos/${h}`;
    const canonicalRemoteWt = `$HOME/.invoker/worktrees/${h}/${san}`;

    handle.branch = experimentBranch;

    const remoteHome = (await this.execRemoteCapture('printf %s "$HOME"')).trim();
    const porcelainScript = `set -euo pipefail
H="${h}"
CLONE="$HOME/.invoker/repos/$H"
git -C "$CLONE" worktree list --porcelain
`;
    const porcelain = await this.execRemoteCapture(porcelainScript);
    const managedPrefix = normalize(`${remoteHome}/.invoker/worktrees/${h}`);
    const reuseAbs = findManagedWorktreeForBranch(porcelain, experimentBranch, [managedPrefix]);

    let remoteWt = canonicalRemoteWt;
    let skippedRemotePreserve = false;

    if (reuseAbs) {
      const wtQ = SshFamiliar.shellPosixSingleQuote(reuseAbs);
      const headScript = `set -euo pipefail
git -C ${wtQ} rev-parse --abbrev-ref HEAD
`;
      try {
        const head = (await this.execRemoteCapture(headScript)).trim();
        if (abbrevRefMatchesBranch(head, experimentBranch)) {
          skippedRemotePreserve = true;
          remoteWt = reuseAbs;
          handle.workspacePath =
            reuseAbs.startsWith(`${remoteHome}/`) ? `~${reuseAbs.slice(remoteHome.length)}` : reuseAbs;
        }
      } catch {
        /* fall through to fresh setup */
      }
    }

    if (!skippedRemotePreserve) {
      const cleanupScript = `set -euo pipefail
CLONE="${remoteClone}"
WT="${canonicalRemoteWt}"
mkdir -p "$(dirname "$WT")"
git -C "$CLONE" worktree prune 2>/dev/null || true
if [ -e "$WT" ]; then
  echo "[SshFamiliar] Removing stale worktree path: $WT"
  git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
  rm -rf "$WT"
  git -C "$CLONE" worktree prune 2>/dev/null || true
fi
`;
      await this.execRemoteCapture(cleanupScript);
      remoteWt = canonicalRemoteWt;
      handle.workspacePath = `~/.invoker/worktrees/${h}/${san}`;
    }

    if (skippedRemotePreserve) {
      await this.mergeRequestUpstreamBranches(request, remoteWt, baseRef);
      handle.branch = experimentBranch;
    } else {
      await this.setupTaskBranch(remoteClone, request, handle, {
        branchName: experimentBranch,
        base: baseRef,
        worktreeDir: remoteWt,
      });
    }

    // Step 4: No-command tasks complete immediately
    if (!request.inputs.command && !request.inputs.prompt) {
      await this.handleProcessExit(executionId, request, remoteWt, 0, {
        branch: experimentBranch,
      });
      return handle;
    }

    // Step 5: Provision + run payload in a single SSH session
    const provB64 = SshFamiliar.b64(DEFAULT_WORKTREE_PROVISION_COMMAND);
    const payloadB64 = SshFamiliar.b64(payload);
    const wtLine =
      remoteWt.startsWith('/')
        ? `WT=${SshFamiliar.shellPosixSingleQuote(remoteWt)}`
        : `WT="${remoteWt}"`;
    const runScript = `set -euo pipefail
${wtLine}
cd "$WT"
echo "[SshFamiliar] Provisioning remote worktree (pnpm install + electron native rebuild)..."
eval "$(echo ${provB64} | base64 -d)"
echo "[SshFamiliar] Running task payload..."
echo ${payloadB64} | base64 -d | bash -se
`;

    return this.spawnSshRemoteStdin(executionId, request, handle, runScript, agentSessionId, {
      worktreePath: handle.workspacePath!,
      branch: experimentBranch,
    });
  }

  /**
   * On the remote host: commit task result (same semantics as local recordTaskResult) then push branch.
   * Returns commit hash on success; `error` if commit or push failed.
   */
  private async remoteGitRecordAndPush(
    executionId: string,
    request: WorkRequest,
    worktreePath: string,
    branch: string,
    commandExitCode: number,
  ): Promise<{ commitHash?: string; error?: string }> {
    const wtB = SshFamiliar.b64(worktreePath);
    const brB = SshFamiliar.b64(branch);
    const msgChanges = this.buildCommitMessage(request);
    const msgEmpty = this.buildResultCommitMessage(request, commandExitCode);
    const chB = SshFamiliar.b64(msgChanges);
    const emB = SshFamiliar.b64(msgEmpty);

    const recordScript = `set -euo pipefail
WT=$(echo ${wtB} | base64 -d)
${SshFamiliar.bashNormalizeWtFromDecodedVar()}
cd "$WT"
git add -A
M=$(mktemp)
trap 'rm -f "$M"' EXIT
if git diff --cached --quiet; then
  echo ${emB} | base64 -d > "$M"
  git commit --allow-empty -F "$M"
else
  echo ${chB} | base64 -d > "$M"
  git commit -F "$M"
fi
git rev-parse HEAD
`;

    let hash: string;
    try {
      const out = (await this.execRemoteCapture(recordScript)).trim();
      const lines = out.split('\n').map((l) => l.trim()).filter(Boolean);
      hash = lines[lines.length - 1] ?? '';
      if (!/^[0-9a-f]{7,40}$/i.test(hash)) {
        return { error: `remote commit: unexpected output (last line: ${hash.slice(0, 80)})` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { error: `remote commit: ${msg}` };
    }

    const pushScript = `set -euo pipefail
WT=$(echo ${wtB} | base64 -d)
${SshFamiliar.bashNormalizeWtFromDecodedVar()}
BR=$(echo ${brB} | base64 -d)
cd "$WT"
git push -u origin "$BR"
`;

    try {
      await this.execRemoteCapture(pushScript);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { commitHash: hash, error: `remote push: ${msg}` };
    }

    return { commitHash: hash };
  }

  /** Run a bash script on the remote (fed to `bash -s` on stdin). */
  private spawnSshRemoteStdin(
    executionId: string,
    request: WorkRequest,
    handle: FamiliarHandle,
    bashScript: string,
    agentSessionId: string | undefined,
    finalizeRemote: { worktreePath: string; branch: string } | undefined,
  ): FamiliarHandle {
    const child = spawn('ssh', [...this.buildSshArgs(), 'bash', '-s'], {
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
          this.emitOutput(executionId, '[SshFamiliar] Recording task result and pushing branch on remote...\n');
          const fin = await this.remoteGitRecordAndPush(
            executionId,
            request,
            finalizeRemote.worktreePath,
            finalizeRemote.branch,
            exitCode,
          );
          if (fin.commitHash) commitHash = fin.commitHash;
          if (fin.error) {
            this.emitOutput(executionId, `[SshFamiliar] ${fin.error}\n`);
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

        const finalExitCode = status === 'failed' && exitCode === 0 ? 1 : exitCode;
        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
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
    console.log(`[SshFamiliar] getRestoredTerminalSpec: meta=${JSON.stringify(meta)}`);
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
    const cdPart = SshFamiliar.sshInteractiveCdFragment(workspacePath);
    console.log(`[SshFamiliar] Building remote terminal inner command. workspacePath=${workspacePath} branch=${branch} agentSessionId=${agentSessionId} executionAgent=${executionAgent}`);
    if (agentSessionId) {
      let resumeCmd: string;
      if (this.agentRegistry) {
        const resume = this.agentRegistry.getOrThrow(executionAgent ?? 'claude').buildResumeArgs(agentSessionId);
        resumeCmd = [resume.cmd, ...resume.args.map(a => SshFamiliar.shellPosixSingleQuote(a))].join(' ');
      } else {
        resumeCmd = `claude --resume ${SshFamiliar.shellPosixSingleQuote(agentSessionId)} --dangerously-skip-permissions`;
      }
      return branch
        ? `${cdPart} && git checkout ${SshFamiliar.shellPosixSingleQuote(branch)} 2>/dev/null; ${resumeCmd}`
        : `${cdPart} && ${resumeCmd}`;
    }
    return branch
      ? `${cdPart} && git checkout ${SshFamiliar.shellPosixSingleQuote(branch)} 2>/dev/null; exec bash -l`
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
