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
  private remoteRefs = new Map<string, string>();

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
    this.remoteRefs.clear();
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
        this.applySuccessfulCommandSideEffects(args);
        return script.response;
      }
    }

    // Default responses for common commands
    if (args[0] === 'branch' && args[1] === '--show-current') return this.defaultBranch;
    if (args[0] === 'checkout') return this.returnSuccess(args);
    if (args[0] === 'merge') return this.returnSuccess(args);
    if (args[0] === 'rebase') return '';
    if (args[0] === 'commit') return this.returnSuccess(args);
    if (args[0] === 'branch') return '';
    if (args[0] === 'symbolic-ref') return `refs/remotes/origin/${this.defaultBranch}`;
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'push') return this.returnSuccess(args);
    if (args[0] === 'ls-remote') return this.lsRemote(args);
    // diff --cached --quiet exits non-zero when there are staged changes
    if (args[0] === 'diff' && args.includes('--cached') && args.includes('--quiet')) {
      if (this.hasStagedChanges) {
        throw new Error('exit code 1');
      }
      return '';
    }
    return '';
  }

  private returnSuccess(args: string[]): string {
    this.applySuccessfulCommandSideEffects(args);
    return '';
  }

  private applySuccessfulCommandSideEffects(args: string[]): void {
    if (args[0] === 'checkout') {
      this.hasStagedChanges = false;
    } else if (args[0] === 'merge' && args.includes('--squash')) {
      this.hasStagedChanges = true;
    } else if (args[0] === 'commit') {
      this.hasStagedChanges = false;
    } else if (args[0] === 'push') {
      this.recordPushedRefs(args);
    }
  }

  private recordPushedRefs(args: string[]): void {
    for (const spec of args.slice(1)) {
      const separator = spec.indexOf(':');
      if (separator <= 0) continue;
      const source = spec.slice(0, separator);
      const destination = spec.slice(separator + 1);
      if (!destination.startsWith('refs/heads/')) continue;
      this.remoteRefs.set(destination, this.shaForRef(source));
    }
  }

  private shaForRef(ref: string): string {
    return ref === 'HEAD' ? 'abc123' : 'abc123';
  }

  private lsRemote(args: string[]): string {
    if (!args.includes('--heads')) return '';
    const remote = args.find((arg, index) => index > 0 && args[index - 1] !== 'ls-remote' && !arg.startsWith('-'));
    if (remote !== 'origin') return '';
    const branch = args[args.length - 1];
    const ref = `refs/heads/${branch}`;
    const sha = this.remoteRefs.get(ref);
    return sha ? `${sha}\t${ref}` : '';
  }
}
