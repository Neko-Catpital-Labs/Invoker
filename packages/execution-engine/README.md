# @invoker/execution-engine

Task execution engine and runners for Invoker.

## Responsibility

Concrete task execution implementations. Runs commands, manages process lifecycle, handles I/O streaming, and enforces execution constraints.

## Git Fetch Behavior

### Background: Silent Fetch Failures

Earlier versions of Invoker silently ignored `git fetch` failures when starting tasks. If SSH authentication failed, network was unavailable, or the remote was unreachable, tasks ran against potentially stale local branches with no indication that synchronization had failed.

This created risks:
- Tasks running against outdated code
- Merge conflicts from stale branches
- Silent divergence from remote state
- No visibility into why branches were stale

### Current Behavior: Fetch Failures Abort the Task

Every executor (worktree, docker, ssh) runs `git fetch origin` before starting a task. If that fetch fails for any reason, the task aborts immediately with a clear error. There is no lenient mode.

When `git fetch origin` fails:
1. A status line is emitted to the task output stream:
   `[Git Fetch] Status: FAILED | Error: <error> | Aborting task`
2. `syncFromRemote` throws `Git fetch failed: <error>`
3. The task fails with a non-zero exit code before any work starts

When `git fetch origin` succeeds:
1. A status line is emitted to the task output stream:
   `[Git Fetch] Status: success | Last fetch: X seconds ago | Staleness: <detail>`
2. Staleness is reported as either `0 commits behind origin/<branch>`,
   `N commits behind origin/<branch>`, `no remote tracking branch`, or
   `detached HEAD`.
3. A loud warning (`[Git Fetch] WARNING: Local is N commits behind origin`)
   is emitted when the branch is more than 100 commits behind. Staleness is
   informational — the task still runs.

### Configuration

No configuration is required. Executors accept only transport settings:

```typescript
import { WorktreeExecutor } from '@invoker/execution-engine';

const executor = new WorktreeExecutor({
  cacheDir: '/path/to/cache',
});
```

If `git fetch` fails (missing SSH key, offline, broken remote, etc.), fix
the underlying issue and rerun the task.

### Example output

#### Fetch failure (SSH key missing)

```
[Git Fetch] Status: FAILED | Error: ssh: Could not resolve hostname github.com | Aborting task
Error: Git fetch failed: ssh: Could not resolve hostname github.com
Exit code: 1
```

#### Fetch success, branch up to date

```
[Git Fetch] Status: success | Last fetch: 1 second ago | Staleness: 0 commits behind origin/main
```

#### Fetch success, significantly behind

```
[Git Fetch] Status: success | Last fetch: 2 seconds ago | Staleness: 150 commits behind origin/main
[Git Fetch] WARNING: Local is 150 commits behind origin
```
