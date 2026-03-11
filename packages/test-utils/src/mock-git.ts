import type { TaskExecutor } from '@invoker/executors';

interface ScriptedResponse {
  match: (args: string[]) => boolean;
  response: string | Error;
  once: boolean;
  used: boolean;
}

/**
 * Scriptable git mock that records all execGit calls and lets you
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

  /** Script a response for calls matching a predicate. */
  on(match: (args: string[]) => boolean, response: string | Error, once = false): this {
    this.scripts.push({ match, response, once, used: false });
    return this;
  }

  /** Shorthand: script a response when first arg matches. */
  onCommand(cmd: string, response: string | Error, once = false): this {
    return this.on((args) => args[0] === cmd, response, once);
  }

  /** Script merge to fail. */
  onMerge(error: Error): this {
    return this.on(
      (args) => args[0] === 'merge' && args.includes('--no-ff'),
      error,
    );
  }

  /** Script merge to succeed (removes any previous merge failure script). */
  onMergeSucceed(): this {
    this.scripts = this.scripts.filter(
      (s) => !(s.match(['merge', '--no-ff', '-m', 'x', 'x']) === true && s.response instanceof Error),
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
    return this;
  }

  /** Replace execGit on a TaskExecutor instance. */
  install(executor: TaskExecutor): void {
    (executor as any).execGit = async (args: string[]) => {
      this.calls.push([...args]);
      return this.resolve(args);
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
    if (args[0] === 'checkout') return '';
    if (args[0] === 'merge') return '';
    if (args[0] === 'rebase') return '';
    if (args[0] === 'branch') return '';
    if (args[0] === 'symbolic-ref') return `refs/remotes/origin/${this.defaultBranch}`;
    if (args[0] === 'rev-parse') return 'abc123';
    if (args[0] === 'push') return '';
    return '';
  }
}
