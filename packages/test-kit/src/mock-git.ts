import type { TaskRunner } from '@invoker/execution-engine';

interface ScriptedResponse {
  match: (args: string[]) => boolean;
  response: string | Error;
  once: boolean;
  used: boolean;
}

/**
 * Scriptable git mock that records all git calls and lets you
 * script success/failure responses per command pattern.
 *
 * Usage:
 *   const git = new MockGit();
 *   git.onMerge(() => new Error('CONFLICT'));
 *   git.install(executor);
 */
export class MockGit {
  calls: string[][] = [];
  private scripts: ScriptedResponse[] = [];
  private defaultBranch = 'master';
  private currentBranch: string | undefined = 'master';
  private currentHead = 'abc123';
  private localHeads = new Map<string, string>([['master', 'abc123']]);
  private remoteHeads = new Map<string, string>([['master', 'abc123']]);
  private hasStagedChanges = false;

  /** Script a response for calls matching a predicate. */
  on(match: (args: string[]) => boolean, response: string | Error, once = false): this {
    this.scripts.push({ match, response, once, used: false });
    return this;
  }

  /** Shorthand: script a response when first arg matches. */
  onCommand(cmd: string, response: string | Error, once = false): this {
    return this.on((args) => args[0] === cmd, response, once);
  }

  /** Script merge to fail (matches both --no-ff consolidation and --squash final merges). */
  onMerge(error: Error): this {
    return this.on(
      (args) => args[0] === 'merge' && (args.includes('--no-ff') || args.includes('--squash')),
      error,
    );
  }

  /** Script merge to succeed (removes any previous merge failure script). */
  onMergeSucceed(): this {
    this.scripts = this.scripts.filter(
      (s) => {
        const matchesNoFf = s.match(['merge', '--no-ff', '-m', 'x', 'x']) === true;
        const matchesSquash = s.match(['merge', '--squash', 'x']) === true;
        return !((matchesNoFf || matchesSquash) && s.response instanceof Error);
      },
    );
    return this;
  }

  /** Script rebase to fail for a specific branch. */
  onRebaseFail(branch: string, error: Error): this {
    return this.on(
      (args) => args[0] === 'rebase' && this.lastCheckoutBranch() === branch,
      error,
    );
  }

  /** Remove all scripted responses. */
  reset(): this {
    this.scripts = [];
    this.calls = [];
    this.currentBranch = this.defaultBranch;
    this.currentHead = 'abc123';
    this.localHeads = new Map([[this.defaultBranch, this.currentHead]]);
    this.remoteHeads = new Map([[this.defaultBranch, this.currentHead]]);
    this.hasStagedChanges = false;
    return this;
  }

  /** Replace execGitReadonly, execGitIn, and worktree methods on a TaskRunner instance. */
  install(executor: TaskRunner): void {
    (executor as any).execGitReadonly = async (args: string[]) => {
      this.calls.push([...args]);
      return this.resolve(args);
    };
    (executor as any).execGitIn = async (args: string[], _dir: string) => {
      this.calls.push([...args]);
      return this.resolve(args);
    };
    (executor as any).createMergeWorktree = async (_ref: string, _label: string) => {
      return '/tmp/mock-merge-worktree';
    };
    (executor as any).removeMergeWorktree = async (_dir: string) => {
      // no-op in tests
    };
  }

  /** Get all calls to a specific git subcommand. */
  getCalls(cmd: string): string[][] {
    return this.calls.filter((c) => c[0] === cmd);
  }

  private lastCheckoutBranch(): string {
    const checkouts = this.getCalls('checkout');
    if (checkouts.length === 0) return '';
    const last = checkouts[checkouts.length - 1];
    return last[last.length - 1];
  }

  private resolve(args: string[]): string {
    for (const script of this.scripts) {
      if (script.once && script.used) continue;
      if (script.match(args)) {
        script.used = true;
        if (script.response instanceof Error) throw script.response;
        return script.response;
      }
    }

    // Default responses for common commands
    if (args[0] === 'branch' && args[1] === '--show-current') return this.defaultBranch;
    if (args[0] === 'checkout') {
      this.hasStagedChanges = false;
      if (args[1] === '-b' && args[2]) {
        this.currentBranch = args[2];
        this.localHeads.set(args[2], this.currentHead);
        return '';
      }
      const target = args[args.length - 1];
      if (target && !target.startsWith('-')) {
        this.currentBranch = args.includes('--detach') ? undefined : target;
        this.currentHead = this.resolveRefSha(target);
      }
      return '';
    }
    if (args[0] === 'merge') {
      if (args.includes('--squash')) {
        this.hasStagedChanges = true;
      }
      this.updateCurrentBranchHead();
      return '';
    }
    if (args[0] === 'rebase') return '';
    if (args[0] === 'commit') {
      this.hasStagedChanges = false;
      this.updateCurrentBranchHead();
      return '';
    }
    if (args[0] === 'branch') return '';
    if (args[0] === 'symbolic-ref') return `refs/remotes/origin/${this.defaultBranch}`;
    if (args[0] === 'rev-parse') return this.resolveRefSha(args[args.length - 1]);
    if (args[0] === 'push') {
      this.recordPush(args);
      return '';
    }
    if (args[0] === 'ls-remote') return this.lsRemote(args);
    if (args[0] === 'update-ref' && args[1]?.startsWith('refs/heads/') && args[2]) {
      this.localHeads.set(args[1].slice('refs/heads/'.length), args[2]);
      return '';
    }
    // diff --cached --quiet exits non-zero when there are staged changes
    if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      if (this.hasStagedChanges) {
        throw new Error('exit code 1');
      }
      return '';
    }
    return '';
  }

  private updateCurrentBranchHead(): void {
    if (this.currentBranch) {
      this.localHeads.set(this.currentBranch, this.currentHead);
    }
  }

  private resolveRefSha(ref: string | undefined): string {
    if (!ref || ref === 'HEAD') return this.currentHead;
    const normalized = ref
      .replace(/\^\{commit\}$/, '')
      .replace(/^refs\/heads\//, '')
      .replace(/^refs\/remotes\/origin\//, '');
    return this.localHeads.get(normalized)
      ?? this.remoteHeads.get(normalized)
      ?? this.currentHead;
  }

  private recordPush(args: string[]): void {
    const remoteIndex = args.findIndex((arg, index) => index > 0 && !arg.startsWith('-'));
    if (remoteIndex < 0) return;
    const refspecs = args.slice(remoteIndex + 1).filter((arg) => arg && !arg.startsWith('-'));
    for (const refspec of refspecs) {
      const [sourceRef, destinationRef] = refspec.includes(':')
        ? refspec.split(/:(.*)/s, 2)
        : [refspec, refspec];
      const branch = destinationRef?.replace(/^refs\/heads\//, '');
      if (!branch) continue;
      this.remoteHeads.set(branch, this.resolveRefSha(sourceRef));
    }
  }

  private lsRemote(args: string[]): string {
    const branch = args[args.length - 1];
    if (!branch || branch.startsWith('-')) return '';
    const sha = this.remoteHeads.get(branch);
    return sha ? `${sha}\trefs/heads/${branch}` : '';
  }
}
