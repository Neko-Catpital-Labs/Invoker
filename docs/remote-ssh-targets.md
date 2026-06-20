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

### Fields

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

## Crabbox-backed Targets

Crabbox supplies the machine; Invoker still runs the normal SSH executor. A Crabbox target leases a box on demand, waits for it to report a reachable SSH endpoint, then connects with the same `runnerKind: ssh` path used for static targets. There is no `runnerKind: crabbox` — Crabbox only changes how the SSH endpoint is obtained.

Add a Crabbox target alongside static ones under `remoteTargets`:

```json
{
  "remoteTargets": {
    "crabbox-ci": {
      "type": "crabbox",
      "crabboxCommand": "crabbox",
      "provider": "fly",
      "class": "performance-4x",
      "ttl": "1h",
      "idleTimeout": "20m",
      "network": "default",
      "target": "ubuntu-22.04",
      "stopAfter": "success",
      "keepOnFailure": true
    }
  }
}
```

Reference it from a task exactly like any SSH target — `runnerKind: ssh` plus the Crabbox target id as `poolMemberId`:

```yaml
  - id: ci-on-crabbox
    description: "Run CI on a leased Crabbox box"
    command: "pnpm run test:all"
    runnerKind: ssh
    poolMemberId: crabbox-ci
```

### Crabbox fields

| Field | Required | Description |
|-------|----------|-------------|
| `type` | yes | Must be `crabbox` |
| `crabboxCommand` | yes | Path or name of the Crabbox CLI |
| `provider` | yes | Backend the box is requested from |
| `class` | yes | Box class/size |
| `ttl` | yes | Lease time-to-live (e.g. `1h`) |
| `idleTimeout` | yes | Idle time before Crabbox reaps the box (e.g. `20m`) |
| `network` | yes | Network the box attaches to |
| `target` | yes | Machine/image identifier to lease |
| `stopAfter` | yes | When Invoker tears the box down: `success`, `always`, or `never` |
| `keepOnFailure` | no | When true, leave the box up after a failed task for inspection (default: true) |

### stopAfter and keepOnFailure

- `stopAfter: success` — stop the box after a passing task. On failure, the box stays up only when `keepOnFailure` is true (the default); set `keepOnFailure: false` to stop it even on failure.
- `stopAfter: always` — always stop the box when the task ends, pass or fail.
- `stopAfter: never` — never stop the box; you tear it down yourself.

Stopping runs `crabbox stop <lease>` for you.

### Recovery commands

If a box is kept (failure with `keepOnFailure`, or `stopAfter: never`), use the lease id Invoker recorded:

```bash
crabbox ssh --id <lease>    # open an interactive shell on the box
crabbox stop <lease>        # tear the box down when you're done
```

> **Warning:** `keepOnFailure` does not defeat Crabbox's own `ttl` or idle cleanup. A kept box is still reaped when its lease expires or it sits idle past `idleTimeout`. Inspect it promptly, and don't rely on it staying around.

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
5. For `claude` action types, the Claude CLI command is shell-quoted and executed remotely.

### SSH options

The executor uses these SSH options by default:

- `-o StrictHostKeyChecking=accept-new` — auto-accept new host keys (TOFU), reject changed keys
- `-o BatchMode=yes` — fail immediately if interactive auth is needed (no password prompts)

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
