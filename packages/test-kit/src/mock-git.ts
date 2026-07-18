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
  private hasStagedChanges = false;
  private remoteHeads = new Map<string, string>();
  private readonly defaultSha = 'abc123';

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
    this.hasStagedChanges = false;
    this.remoteHeads.clear();
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
      // Reset staged changes on checkout
      this.hasStagedChanges = false;
      return '';
    }
    if (args[0] === 'merge') {
      // Squash merge stages changes
      if (args.includes('--squash')) {
        this.hasStagedChanges = true;
      }
      return '';
    }
    if (args[0] === 'rebase') return '';
    if (args[0] === 'commit') {
      // Commit clears staged changes
      this.hasStagedChanges = false;
      return '';
    }
    if (args[0] === 'branch') return '';
    if (args[0] === 'symbolic-ref') return `refs/remotes/origin/${this.defaultBranch}`;
    if (args[0] === 'rev-parse') return this.defaultSha;
    if (args[0] === 'push') {
      this.recordPush(args);
      return '';
    }
    if (args[0] === 'ls-remote' && args.includes('--heads')) {
      const branch = this.lsRemoteBranch(args);
      if (!branch) return '';
      const sha = this.remoteHeads.get(branch);
      return sha ? `${sha}\trefs/heads/${branch}\n` : '';
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

  private recordPush(args: string[]): void {
    const refspec = args[args.length - 1] ?? '';
    if (!refspec || refspec.startsWith('-') || refspec === 'origin') return;
    const remoteRef = refspec.includes(':') ? refspec.split(':').pop()! : refspec;
    const branch = remoteRef.replace(/^refs\/heads\//, '');
    if (branch.length === 0) return;
    this.remoteHeads.set(branch, this.defaultSha);
  }

  private lsRemoteBranch(args: string[]): string | undefined {
    const dashDash = args.indexOf('--');
    if (dashDash >= 0 && args[dashDash + 1]) return args[dashDash + 1];
    const headsIdx = args.indexOf('--heads');
    if (headsIdx >= 0) {
      for (let i = headsIdx + 1; i < args.length; i += 1) {
        const value = args[i]!;
        if (value === 'origin' || value.startsWith('-')) continue;
        return value;
      }
    }
    return undefined;
  }
}
