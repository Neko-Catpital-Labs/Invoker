# Remote SSH Targets

Execute Invoker tasks on remote machines via SSH key-based authentication.

## Overview

The SSH executor (`runnerKind: ssh`) runs task commands on remote hosts over SSH. Authentication is exclusively key-based — no password auth or `sshpass` dependency is required.

Each remote target is defined in the Invoker config with a host, user, and path to an SSH private key. Tasks reference targets by ID.

## Configuration

Add remote targets to `~/.invoker/config.json`.

If you want to use a repo-specific config file, launch Invoker with `INVOKER_REPO_CONFIG_PATH=/path/to/config.json`.

```json
{
  "remoteTargets": {
    "staging-server": {
      "host": "192.168.1.100",
      "user": "deploy",
      "sshKeyPath": "/home/user/.ssh/id_staging",
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile",
      "remoteHeartbeatIntervalSeconds": 30
    },
    "staging-server-b": {
      "host": "192.168.1.101",
      "user": "deploy",
      "sshKeyPath": "/home/user/.ssh/id_staging_b",
      "port": 22,
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile",
      "remoteHeartbeatIntervalSeconds": 30
    }
  }
}
```
Managed SSH workspaces only clone, fetch, and prepare the repo checkout. Invoker does not infer repo bootstrap from package-manager commands and does not install dependencies automatically. Every package-manager, build, or test command that runs on managed SSH needs one explicit bootstrap owner:

- Target-owned bootstrap: set `provisionCommand` on the remote target. Invoker runs it inside the task workspace before each SSH task payload. Use this for stable repo setup such as `pnpm install --frozen-lockfile` or `flutter pub get`.
- Task-owned bootstrap: when the target has no `provisionCommand`, or when setup is task-specific, put the repo-owned setup at the start of the task command, for example `pnpm install --frozen-lockfile && pnpm test`.

Do not rely on ambient `node_modules`, package caches, or setup performed by a previous task. Managed workspaces are disposable execution capacity.

## Owner-host workers

Remote SSH targets execute workflow tasks only. Long-lived operator automation belongs on the Invoker owner host, where the process owns the workflow database and worker registry.

For the supported PR-maintenance setup, enable `prMaintenance` in `~/.invoker/config.json` on the owner host and run the built-in worker kinds from the Workers tab or headless CLI:

```bash
./run.sh --headless worker status --output text
./run.sh --headless worker coderabbit-address
./run.sh --headless worker pr-conflict-rebase
./run.sh --headless worker pr-ci-failure-scan
```

Do not install separate cron jobs on SSH targets for these maintenance paths. The workers share the owner process, owner database, and per-kind worker locks; SSH targets stay disposable execution capacity.

### Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Remote host IP or hostname |
| `user` | string | yes | SSH username |
| `sshKeyPath` | string | yes | Absolute path to SSH private key file |
| `port` | number | no | SSH port (default: 22) |
| `managedWorkspaces` | boolean | no | When true, Invoker clones/fetches the repo and manages per-task worktrees on the remote host |
| `remoteInvokerHome` | string | no | Base directory used by managed remote workspaces (default: `~/.invoker`) |
| `provisionCommand` | string | no | Target-owned bootstrap command run inside the task workspace before each SSH task payload; unset means no provisioning, so task commands that need setup must bootstrap themselves |
| `remoteHeartbeatIntervalSeconds` | number | no | Interval (seconds) for SSH remote workload heartbeat markers used by executing-stall detection (default: `30`) |

## Multiple SSH Targets

You can configure as many remote targets as you want under `remoteTargets`. Each task picks one with `poolId`.

```yaml
name: "Run tasks on multiple remotes"
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: master
tasks:
  - id: check-a
    description: "Run tests on remote A"
    command: "pnpm test"
    poolId: staging-server

  - id: check-b
    description: "Run tests on remote B"
    command: "pnpm test"
    poolId: staging-server-b
```

The `pnpm test` commands above rely on both example targets owning bootstrap through `provisionCommand`. If a selected target does not configure `provisionCommand`, write the command as `pnpm install --frozen-lockfile && pnpm test` or use the repo's equivalent setup command first.

This is the simplest way to target specific SSH machines: define multiple `remoteTargets`, then point each task at the target ID it should use. If you need queueing, load balancing, or mixed local/SSH routing, put those target IDs inside `executionPools` and use the pool name as `poolId` instead.

## Usage in Plans

Reference a remote target in a plan YAML task:

```yaml
name: "Deploy to staging"
onFinish: none
baseBranch: master
tasks:
  - id: health-check
    description: "Verify staging server is reachable"
    command: "echo 'OK'; uptime; df -h"
    poolId: staging-server
    dependencies: []

  - id: run-migrations
    description: "Run database migrations on staging"
    command: "cd /opt/app && ./migrate.sh"
    poolId: staging-server
    dependencies:
      - health-check
```

### Task fields

- `poolId: <id>` — references either a `remoteTargets` key directly or an `executionPools` key that contains SSH members

The executor validates at runtime that the selected target or pool exists and resolves to an SSH-capable execution route.

### Package-script verification

Remote verification should use repo/package scripts when they exist instead of raw runner binaries. For example, `packages/ui/package.json` defines `test` as `node scripts/run-vitest.mjs`, so a managed SSH verification command should use the script:

```yaml
tasks:
  - id: verify-ui
    description: "Run UI tests through the package script"
    command: "pnpm --filter @invoker/ui test"
    poolId: staging-server
    dependencies: []
```

Avoid commands such as `cd packages/ui && npx vitest run` or `pnpm --filter @invoker/ui exec vitest run` when the package script exists, because they bypass repo-owned wrappers and may assume dependencies or runtime flags that only the script provides. The same bootstrap rule still applies: this command is valid on managed SSH only when the target has `provisionCommand`, or when the command starts with the repo bootstrap.

## How It Works

1. The plan parser reads `poolId` from YAML and stores it on the task config.
2. At dispatch time, Invoker resolves that `poolId` either directly to a `remoteTargets` entry or to an `executionPools` member selection.
3. An `SshExecutor` instance is created with the chosen target's connection details.
4. If the selected target has `provisionCommand`, the runner executes that command inside the task workspace before the task payload. If it is unset, no provisioning is inferred.
5. The runner spawns: `ssh -i <keyPath> -p <port> -o StrictHostKeyChecking=accept-new -o BatchMode=yes user@host <command>`
6. For `claude` action types, the Claude CLI command is shell-quoted and executed remotely.

### SSH options

The executor uses these SSH options by default:

- `-o StrictHostKeyChecking=accept-new` — auto-accept new host keys (TOFU), reject changed keys
- `-o BatchMode=yes` — fail immediately if interactive auth is needed (no password prompts)

## SSH Pool Capacity (Lease-Backed)

SSH member capacity is decided by durable host-keyed leases in `execution_resource_leases`, not by in-memory runner maps.

- **Resource key:** `ssh:user@host:port`. The same droplet listed in multiple pools (for example `mixed-local-ssh` and `pnpm-ssh`) shares one capacity budget.
- **Counted holders:** a key may hold up to `maxConcurrentTasksPerMember` (or the member override) live leases. Limit `1` is the exclusive case used in production today.
- **Claim-at-select:** the runner acquires the lease while selecting a pool member, before start. Dispatch renews an already-held lease instead of claiming again.
- **In-memory maps:** `activeExecutions` / `pendingPoolSelections` still drive kill, heartbeat, and start plumbing, but they do **not** contribute to SSH `poolMemberLoad`. Worktree pool members still use in-memory load.
- **Reclaim:** orphan-executor reclaim remains useful cleanup; it is not the source of truth for “is this host full?”.
- **Inspect:** with the GUI/owner up, `./run.sh --headless query execution-leases [--output json|text|label]` lists live holders (`resourceKey`, `poolId`, `poolMemberId`, `taskId`, `holderId`, expiry).
- **Regression gate:** `bash scripts/repro/repro-ssh-lease-capacity-battery.sh --gate` (orphan ghosts, cross-pool exclusivity, churn refill, lease/occupancy parity).

## Member Health & Circuit Breaker

When an SSH pool member fails to *start* a task with a transport-level error — connection timed out, connection reset, `exit=255`, broken pipe, banner-exchange / `kex_exchange_identification` failure, or an operation timeout — the runner takes that member **out of rotation** instead of offering it to the next task and eating another connection-timeout stall.

- **Eviction.** The failing member is marked down for a cooldown window and skipped during pool selection (`roundRobin` and `leastLoaded` both honor it). The window backs off exponentially per consecutive failure — 30s, 60s, 120s, … capped at 5 minutes — so a machine that stays offline is retried less and less often.
- **Failover.** Within the same dispatch, the task immediately retries another healthy SSH member if one exists; the down member simply stops being a candidate for subsequent tasks.
- **Automatic re-admission.** A member returns to rotation on the first successful start on it, or once its cooldown elapses (a half-open probe attempt). No operator action is required when the machine comes back.
- **All members down.** If every member is in cooldown, the task defers with a `down <n>s` reason in the pool-capacity message and is retried later — it is never hard-failed for a transient outage. A mixed pool degrades to its local `worktree` member, which is never subject to transport eviction.
- **Observability.** Each transition emits a `task.executor.member-evicted` / `task.executor.member-readmitted` lifecycle event on the task, and `TaskRunner.getPoolMemberHealthSnapshot()` lists the currently-down members.

Health is in-memory and ephemeral by design: a process restart clears it and re-probes every member. It applies only to SSH members (transport errors are SSH-specific).

## Terminal Restore

When opening a terminal for a completed SSH task (via the UI "Open Terminal" button), the runner produces a `TerminalSpec` with `command: 'ssh'` and the target's connection args. This opens an interactive SSH session to the remote host.

## E2E Verification

A verification script is provided for testing SSH connectivity to a DigitalOcean droplet:

```bash
INVOKER_DO_HOST="178.128.181.133" \
INVOKER_DO_USER="root" \
INVOKER_DO_SSH_KEY="$HOME/.ssh/id_do" \
bash scripts/verify-digitalocean-e2e.sh
```

## Security Notes

- SSH keys must never be committed to the repository. The `sshKeyPath` field is a local filesystem path, not the key content.
- The `poolMemberId` stored in the task config and SQLite database is a non-secret alias — it contains no credentials.
- `BatchMode=yes` ensures SSH never falls back to interactive password prompts.
