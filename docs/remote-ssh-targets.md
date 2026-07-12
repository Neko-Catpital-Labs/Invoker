# Remote SSH Targets and Owner-Host Workers

Run Invoker task execution on remote machines via SSH, while operator automation runs inside the single Invoker owner process.

## Overview

The SSH executor (`runnerKind: ssh`) runs task commands on remote hosts over SSH. Authentication is exclusively key-based — no password auth or `sshpass` dependency is required.

Remote targets are execution substrates only. Recovery, PR maintenance, CI-failure repair, disk-headroom checks, and workflow resume automation are built-in owner-host workers. Run them from the owner process; do not configure a separate host scheduler against the workflow database.

## Configuration

Add remote execution targets and owner-host worker settings to `~/.invoker/config.json`.

If you want to use a repo-specific config file, launch the owner with `INVOKER_REPO_CONFIG_PATH=/path/to/config.json`.

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
  },
  "autoFixRetries": 3,
  "autoFixAgent": "codex",
  "autoFixCi": true,
  "prMaintenance": {
    "enabled": true,
    "intervalMs": 300000
  }
}
```

### Remote target fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Remote host IP or hostname |
| `user` | string | yes | SSH username |
| `sshKeyPath` | string | yes | Absolute path to SSH private key file |
| `port` | number | no | SSH port (default: 22) |
| `managedWorkspaces` | boolean | no | When true, Invoker clones/fetches the repo and manages per-task worktrees on the remote host |
| `remoteInvokerHome` | string | no | Base directory used by managed remote workspaces (default: `~/.invoker`) |
| `provisionCommand` | string | no | Command run after worktree creation in managed mode |
| `remoteHeartbeatIntervalSeconds` | number | no | Interval (seconds) for SSH remote workload heartbeat markers used by executing-stall detection (default: `30`) |

### Owner-host worker fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `autoFixRetries` | number | no | Per-task retry budget consumed by the built-in auto-fix worker; `0` disables task auto-fix |
| `autoFixAgent` | string | no | Preferred agent for built-in auto-fix submissions |
| `autoFixCi` | boolean | no | Enables the built-in CI-failure worker to submit fixes for failed review-gate checks |
| `prMaintenance.enabled` | boolean | no | Enables built-in PR-maintenance workers on the owner host |
| `prMaintenance.intervalMs` | number | no | Poll cadence for built-in PR-maintenance workers |

Only one owner process should enable owner-host workers for a shared workflow database. Use the Workers tab or `./run.sh --headless worker status --output text` to inspect worker ownership and recent decisions.

## Owner-Host Worker Setup

1. Start exactly one writable owner: the desktop app, or a headless owner such as `./run.sh --headless owner-serve`.
2. Put recovery and maintenance settings in that owner's Invoker config.
3. Let the owner auto-start built-in workers, or start/stop them from the Workers tab. Headless `worker` commands use the same worker implementations for explicit operator scans.
4. Configure `remoteTargets` only for task execution capacity. SSH targets do not own recovery or PR-maintenance decisions.

This is the supported owner-host path. The owner owns SQLite writes, workers read durable state through the owner process, and worker actions are recorded for status/audit queries.

## Multiple SSH Targets

You can configure as many remote targets as you want under `remoteTargets`. Each task picks one by `poolMemberId`.

```yaml
name: "Run tasks on multiple remotes"
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: master
tasks:
  - id: check-a
    description: "Run tests on remote A"
    command: "pnpm test"
    runnerKind: ssh
    poolMemberId: staging-server

  - id: check-b
    description: "Run tests on remote B"
    command: "pnpm test"
    runnerKind: ssh
    poolMemberId: staging-server-b
```

This is the supported way to run multiple SSH executors in one workflow: define multiple targets, then attach different tasks to different target IDs.

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
    runnerKind: ssh
    poolMemberId: staging-server
    dependencies: []

  - id: run-migrations
    description: "Run database migrations on staging"
    command: "cd /opt/app && ./migrate.sh"
    runnerKind: ssh
    poolMemberId: staging-server
    dependencies:
      - health-check
```

### Task fields

- `runnerKind: ssh` — selects the SSH executor
- `poolMemberId: <id>` — references a key in `remoteTargets` config

Both fields are required for SSH tasks. The executor validates at runtime that the `poolMemberId` exists in config and throws a clear error if it's missing.

## How It Works

1. The plan parser reads `runnerKind` and `poolMemberId` from YAML and carries them through to `TaskConfig`.
2. When `TaskRunner.selectExecutor()` sees `runnerKind: ssh`, it looks up the `poolMemberId` in the `remoteTargets` config map.
3. An `SshExecutor` instance is created with the target's connection details.
4. The runner spawns: `ssh -i <keyPath> -p <port> -o StrictHostKeyChecking=accept-new -o BatchMode=yes user@host <command>`
5. Built-in workers run separately inside the owner process and submit normal owner commands when recovery or maintenance is needed.

### SSH options

The executor uses these SSH options by default:

- `-o StrictHostKeyChecking=accept-new` — auto-accept new host keys (TOFU), reject changed keys
- `-o BatchMode=yes` — fail immediately if interactive auth is needed (no password prompts)

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
