# Remote SSH Targets

Execute Invoker tasks on remote machines via SSH key-based authentication.

## Overview

The SSH executor (`executorType: ssh`) runs task commands on remote hosts over SSH. Authentication is exclusively key-based — no password auth or `sshpass` dependency is required.

Each remote target is defined in the Invoker config with a host, user, and path to an SSH private key. Tasks route through `poolId` only.

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
      "maxConcurrentTasks": 1,
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
      "maxConcurrentTasks": 1,
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile",
      "remoteHeartbeatIntervalSeconds": 30
    }
  },
  "executionPools": {
    "ssh-light": {
      "members": [
        { "type": "ssh", "id": "staging-server" },
        { "type": "ssh", "id": "staging-server-b" },
        { "type": "worktree", "id": "local-fallback", "maxConcurrentTasks": 2 }
      ],
      "selectionStrategy": "roundRobin",
      "maxConcurrentTasksPerMember": 1
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
| `maxConcurrentTasks` | number | no | Per-target cap used by SSH execution pools (default in pools: 1) |

### executionPools fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `members` | array | yes | Member objects: `{ "type": "ssh" \| "worktree", "id": "<member-id>" }` |
| `selectionStrategy` | `"roundRobin"` \| `"leastLoaded"` | no | Member selection strategy (default: `roundRobin`) |
| `maxConcurrentTasksPerMember` | number | no | Fallback per-member cap when target-level cap is not set |

### Routing to pools from config

Use `executorRoutingRules` with `strategy: "route"` to auto-assign matching commands to an SSH pool.

```json
{
  "executionPools": {
    "ssh-light": {
      "members": [
        { "type": "ssh", "id": "staging-server" },
        { "type": "ssh", "id": "staging-server-b" }
      ],
      "selectionStrategy": "roundRobin",
      "maxConcurrentTasksPerMember": 1
    }
  },
  "executorRoutingRules": [
    {
      "regex": "\\bpnpm(?:\\s|$)",
      "executorType": "ssh",
      "poolId": "ssh-light",
      "strategy": "route"
    }
  ]
}
```

## Multiple SSH Targets

You can configure as many remote targets as you want under `remoteTargets`, then group them into named pools under `executionPools`.

```yaml
name: "Run tasks on multiple remotes"
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: master
tasks:
  - id: check-a
    description: "Run tests on SSH light pool"
    command: "pnpm test"
    executorType: ssh
    poolId: ssh-light

  - id: check-b
    description: "Run lint on SSH light pool"
    command: "pnpm test"
    executorType: ssh
    poolId: ssh-light
```

Queue semantics are shared across pools:
- if all members are at capacity, new tasks wait in that pool queue;
- when a member frees a slot, the next queued task is launched automatically.
- members cannot be shared across pools (for example, the same `ssh:<id>` cannot appear in two pools).

## Usage in Plans

Reference a pool in plan YAML tasks:

```yaml
name: "Deploy to staging"
onFinish: none
baseBranch: master
tasks:
  - id: health-check
    description: "Verify staging server is reachable"
    command: "echo 'OK'; uptime; df -h"
    executorType: ssh
    poolId: ssh-light
    dependencies: []

  - id: run-migrations
    description: "Run database migrations on staging"
    command: "cd /opt/app && ./migrate.sh"
    executorType: ssh
    poolId: ssh-light
    dependencies:
      - health-check
```

### Task fields

- `executorType: ssh` — selects the SSH executor
- `poolId: <id>` — routes through a named pool in `executionPools`
- `remoteTargetId` is no longer accepted in plan YAML.

`poolId` is required for SSH tasks.

## How It Works

1. The plan parser reads `executorType` and `poolId` from YAML.
2. TaskRunner acquires a member slot from the selected pool (shared queue/drain).
3. If the selected member is SSH, an `SshExecutor` instance is resolved from `remoteTargets`.
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
- Selected pool-member IDs stored in runtime task metadata are non-secret aliases; credentials remain only in local config.
- `BatchMode=yes` ensures SSH never falls back to interactive password prompts.
