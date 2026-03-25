import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import type { FamiliarHandle, PersistedTaskMeta, TerminalSpec } from './familiar.js';
import { BaseFamiliar, type BaseEntry } from './base-familiar.js';
import { killProcessGroup, cleanElectronEnv, SIGKILL_TIMEOUT_MS } from './process-utils.js';
import { computeBranchHash } from './worktree-familiar.js';
import { DEFAULT_WORKTREE_PROVISION_COMMAND } from './default-worktree-provision-command.js';

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
 * When `repoUrl` is set on the work request, clones / worktrees on the remote
 * under ~/.invoker (mirroring local RepoPool layout), provisions with the same
 * command as WorktreeFamiliar, then runs the task command in that directory.
 *
 * Without `repoUrl`, runs the raw command remotely (default remote shell cwd,
 * usually ~ — suitable only for commands that do not need the repo).
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
        else reject(new Error(`SSH remote script failed (${code}): ${err.trim() || out.trim()}`));
      });
    });
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

    const repoUrl = request.inputs.repoUrl;
    const command = request.inputs.command;
    const useRemoteWorktree = request.actionType === 'command' && !!repoUrl && !!command;

    if (useRemoteWorktree) {
      return this.startRemoteWorktreeCommand(request, handle, repoUrl!, command!);
    }

    if (request.actionType === 'claude' && repoUrl) {
      throw new Error(
        'SshFamiliar: claude tasks with repoUrl are not supported yet remote worktree + Claude must be wired.',
      );
    }

    let remoteCommand: string;
    let claudeSessionId: string | undefined;

    if (request.actionType === 'command') {
      if (!command) throw new Error('WorkRequest with actionType "command" must have inputs.command');
      remoteCommand = command;
    } else if (request.actionType === 'claude') {
      const session = this.prepareClaudeSession(request);
      claudeSessionId = session.sessionId;
      remoteCommand = `claude ${session.cliArgs.map(a => this.shellQuote(a)).join(' ')}`;
    } else {
      remoteCommand = 'echo "Unsupported action type"';
    }

    return this.spawnSshRemoteStdin(executionId, request, handle, remoteCommand, claudeSessionId, undefined);
  }

  private async startRemoteWorktreeCommand(
    request: WorkRequest,
    handle: FamiliarHandle,
    repoUrl: string,
    command: string,
  ): Promise<FamiliarHandle> {
    const executionId = handle.executionId;
    const h = SshFamiliar.urlHash(repoUrl);
    const baseRef = request.inputs.baseBranch ?? 'HEAD';
    const upstreamCommits = (request.inputs.upstreamContext ?? [])
      .map(c => c.commitHash)
      .filter((x): x is string => !!x);
    const salt = request.inputs.salt ?? '';

    const script1 = `set -euo pipefail
REPO=$(echo ${SshFamiliar.b64(repoUrl)} | base64 -d)
BASE=$(echo ${SshFamiliar.b64(baseRef)} | base64 -d)
H="${h}"
CLONE="$HOME/.invoker/repos/$H"
mkdir -p "$(dirname "$CLONE")"
if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi
git -C "$CLONE" fetch --all
git -C "$CLONE" rev-parse "$BASE"
`;
    const baseHead = (await this.execRemoteCapture(script1)).trim();
    const hash8 = computeBranchHash(
      request.actionId,
      command,
      undefined,
      upstreamCommits,
      baseHead,
      salt,
    );
    const experimentBranch = `experiment/${request.actionId}-${hash8}`;
    const san = experimentBranch.replace(/\//g, '-');
    const upstreamLines = (request.inputs.upstreamBranches ?? []).join('\n');
    const provB64 = SshFamiliar.b64(DEFAULT_WORKTREE_PROVISION_COMMAND);
    const cmdB64 = SshFamiliar.b64(command);
    const branchB64 = SshFamiliar.b64(experimentBranch);
    const upstreamB64 = SshFamiliar.b64(upstreamLines);
    const baseB64 = SshFamiliar.b64(baseRef);

    handle.workspacePath = `~/.invoker/worktrees/${h}/${san}`;
    handle.branch = experimentBranch;

    const script2 = `set -euo pipefail
H="${h}"
SAN="${san}"
REPO=$(echo ${SshFamiliar.b64(repoUrl)} | base64 -d)
BRANCH=$(echo ${branchB64} | base64 -d)
BASE=$(echo ${baseB64} | base64 -d)
CLONE="$HOME/.invoker/repos/$H"
WT="$HOME/.invoker/worktrees/$H/$SAN"
mkdir -p "$(dirname "$CLONE")" "$(dirname "$WT")"
if [ ! -d "$CLONE/.git" ]; then git clone "$REPO" "$CLONE"; fi
git -C "$CLONE" fetch --all
git -C "$CLONE" worktree prune 2>/dev/null || true
if [ -e "$WT" ]; then
  echo "[SshFamiliar] Removing stale worktree path (leftover from a previous run): $WT"
  git -C "$CLONE" worktree remove --force "$WT" 2>/dev/null || true
  rm -rf "$WT"
  git -C "$CLONE" worktree prune 2>/dev/null || true
fi
preserved=0
if git -C "$CLONE" rev-parse --verify "$BRANCH" >/dev/null 2>&1; then
  CLONE_HEAD=$(git -C "$CLONE" rev-parse HEAD)
  AHEAD=$(git -C "$CLONE" rev-list --count "$CLONE_HEAD..$BRANCH" 2>/dev/null || echo 0)
  if [ "\${AHEAD:-0}" -gt 0 ]; then
    git -C "$CLONE" worktree add "$WT" "$BRANCH"
    git -C "$WT" merge --no-edit "$CLONE_HEAD"
    preserved=1
  fi
fi
if [ "$preserved" -eq 0 ]; then
  git -C "$CLONE" worktree add -B "$BRANCH" "$WT" "$BASE"
fi
while IFS= read -r upBranch || [ -n "$upBranch" ]; do
  [ -z "$upBranch" ] && continue
  if git -C "$WT" merge-base --is-ancestor "$upBranch" HEAD 2>/dev/null; then
    echo "[SshFamiliar] Skipping merge of $upBranch — already ancestor"
    continue
  fi
  if ! git -C "$WT" rev-parse --verify "$upBranch" >/dev/null 2>&1; then
    echo "[SshFamiliar] Upstream branch $upBranch does not exist on remote" >&2
    exit 30
  fi
  git -C "$WT" merge --no-edit -m "Invoker: merge $upBranch" "$upBranch" || exit 31
done <<< "$(echo ${upstreamB64} | base64 -d)"
cd "$WT"
echo "[SshFamiliar] Provisioning remote worktree (pnpm install + electron native rebuild)..."
eval "$(echo ${provB64} | base64 -d)"
echo "[SshFamiliar] Running task command..."
echo ${cmdB64} | base64 -d | bash -se
`;

    return this.spawnSshRemoteStdin(executionId, request, handle, script2, undefined, {
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
    claudeSessionId: string | undefined,
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
      claudeSessionId,
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
      void (async () => {
        const exitCode = code ?? (signal ? 1 : 0);
        const e = this.entries.get(executionId);
        if (e) e.completed = true;

        let status: 'completed' | 'failed' = exitCode === 0 ? 'completed' : 'failed';
        let mappedError = exitCode === 30
          ? 'Upstream branch missing on remote clone'
          : exitCode === 31
            ? 'Merge conflict merging upstream branch on remote'
            : undefined;

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

        const response: WorkResponse = {
          requestId: request.requestId,
          actionId: request.actionId,
          status,
          outputs: {
            exitCode: status === 'failed' && exitCode === 0 ? 1 : exitCode,
            commitHash,
            claudeSessionId: entry.claudeSessionId,
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
      const inner = handle.branch
        ? `${SshFamiliar.sshInteractiveCdFragment(handle.workspacePath)} && git checkout ${SshFamiliar.shellPosixSingleQuote(handle.branch)} 2>/dev/null; exec bash -l`
        : `${SshFamiliar.sshInteractiveCdFragment(handle.workspacePath)} && exec bash -l`;
      return {
        command: 'ssh',
        args: [...opts, '-t', userAtHost, 'bash', '-lc', inner],
      };
    }
    return {
      command: 'ssh',
      args: this.buildSshArgs(),
    };
  }

  getRestoredTerminalSpec(meta: PersistedTaskMeta): TerminalSpec {
    if (meta.workspacePath) {
      const base = this.buildSshArgsInteractive();
      const userAtHost = base[base.length - 1]!;
      const opts = base.slice(0, -1);
      const inner = meta.branch
        ? `${SshFamiliar.sshInteractiveCdFragment(meta.workspacePath)} && git checkout ${SshFamiliar.shellPosixSingleQuote(meta.branch)} 2>/dev/null; exec bash -l`
        : `${SshFamiliar.sshInteractiveCdFragment(meta.workspacePath)} && exec bash -l`;
      return {
        command: 'ssh',
        args: [...opts, '-t', userAtHost, 'bash', '-lc', inner],
      };
    }
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
