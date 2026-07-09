# Remote SSH Targets

Run Invoker from one owner host and let its built-in workers coordinate remote SSH execution.

## Supported operator model

The supported remote setup is:

1. Start exactly one Invoker owner process on the machine that owns `~/.invoker`.
2. Configure SSH targets and execution pools in that owner's config.
3. Submit plans to the owner and select remote capacity with `poolId`.
4. Inspect workers and worker decisions from the owner; do not schedule separate cron entrypoints.

The SSH executor still runs task commands on remote hosts over key-based SSH. The owner remains the control plane: it owns the workflow database, worker fleet, task scheduling, retries, and worker decision ledger.

## Owner-host configuration

Add remote targets and pools to the owner host's `~/.invoker/config.json`. For a repo-specific config, launch the owner with `INVOKER_REPO_CONFIG_PATH=/path/to/config.json`.

```json
{
  "maxConcurrency": 6,
  "remoteTargets": {
    "staging-a": {
      "host": "192.168.1.100",
      "user": "deploy",
      "sshKeyPath": "/home/invoker/.ssh/id_staging_a",
      "port": 22,
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile",
      "remoteHeartbeatIntervalSeconds": 30
    },
    "staging-b": {
      "host": "192.168.1.101",
      "user": "deploy",
      "sshKeyPath": "/home/invoker/.ssh/id_staging_b",
      "port": 22,
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile",
      "remoteHeartbeatIntervalSeconds": 30
    }
  },
  "executionPools": {
    "owner-host-ssh": {
      "members": [
        { "type": "ssh", "id": "staging-a" },
        { "type": "ssh", "id": "staging-b" }
      ],
      "selectionStrategy": "roundRobin",
      "maxConcurrentTasksPerMember": 1
    }
  },
  "defaultPoolId": "owner-host-ssh",
  "autoFixRetries": 3,
  "prMaintenance": {
    "enabled": true,
    "repoRoot": "/srv/invoker",
    "intervalMs": 300000
  },
  "webToken": "change-me-to-a-long-random-secret",
  "webHost": "0.0.0.0",
  "webPort": 4200
}
```

### Remote target fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `host` | string | yes | Remote host IP or hostname |
| `user` | string | yes | SSH username |
| `sshKeyPath` | string | yes | Absolute path to the owner's SSH private key file |
| `port` | number | no | SSH port (default: `22`) |
| `maxConcurrentTasks` | number | no | Per-target concurrency cap |
| `managedWorkspaces` | boolean | no | When true, Invoker clones/fetches the repo and manages per-task worktrees on the remote host |
| `remoteInvokerHome` | string | no | Base directory used by managed remote workspaces (default: `~/.invoker`) |
| `provisionCommand` | string | no | Command run after worktree creation in managed mode |
| `remoteHeartbeatIntervalSeconds` | number | no | Interval in seconds for SSH remote workload heartbeat markers used by executing-stall detection (default: `30`) |

## Start the owner host

Run one long-lived owner process from the Invoker checkout on the owner host:

```bash
INVOKER_REPO_CONFIG_PATH=/srv/invoker/config.json \
INVOKER_HEADLESS_STANDALONE=1 \
./run.sh --headless owner-serve
```

If the web surface is enabled, open `http://<owner-host>:4200/?token=<webToken>`. Keep TLS or a trusted tunnel in front of any non-local exposure.

## Usage in plans

Plans should select configured owner pools with `poolId`. They should not embed hostnames, keys, or direct recovery scripts.

```yaml
name: "Run checks on the owner-host SSH pool"
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: master
tasks:
  - id: check-a
    description: "Run checks on remote capacity"
    command: "pnpm test"
    poolId: owner-host-ssh
    dependencies: []

  - id: check-b
    description: "Run another check on remote capacity"
    command: "pnpm test"
    poolId: owner-host-ssh
    dependencies: []
```

Use multiple pools when tasks need different remote capacity classes:

```json
{
  "executionPools": {
    "pnpm-ssh": {
      "members": [
        { "type": "ssh", "id": "staging-a" },
        { "type": "ssh", "id": "staging-b" }
      ],
      "selectionStrategy": "roundRobin",
      "maxConcurrentTasksPerMember": 1
    }
  }
}
```

```yaml
tasks:
  - id: install-and-test
    description: "Run package checks"
    command: "pnpm test"
    poolId: pnpm-ssh
    dependencies: []
```

## Built-in owner workers

Owner workers run inside the owner process and coordinate recovery or maintenance through the normal command routes. Operators should use these built-in workers instead of separate cron entrypoints:

- `autofix` (manual one-shot recovery scan)
- `pr-status`
- `ci-failure`
- `disk-headroom`
- `requeue`
- `auto-approve`
- `coderabbit-address`
- `pr-conflict-rebase`

`autoFixRetries` controls the auto-fix worker retry budget. `prMaintenance.enabled` supplies launch configuration to the built-in `coderabbit-address` and `pr-conflict-rebase` workers.

Inspect the worker fleet and durable decisions from the owner:

```bash
./run.sh --headless query workers --output text
./run.sh --headless query worker-decisions --output text
./run.sh --headless query worker-actions --output text
```

For a deliberate one-shot recovery scan, use the worker command. This invokes the same worker implementation; it is not a separate scheduler:

```bash
./run.sh --headless worker autofix
```

## How SSH execution works

1. The owner parses the plan and stores workflow state in its single writable database.
2. The scheduler picks a ready task and resolves its `poolId` to an SSH pool member.
3. `SshExecutor` creates or updates the managed remote workspace.
4. The executor runs the task command over SSH using `BatchMode=yes`.
5. Remote heartbeat markers feed executing-stall detection.
6. Built-in workers observe durable state and submit normal commands when recovery or maintenance is needed.

### SSH options

The executor uses these SSH options by default:

- `-o StrictHostKeyChecking=accept-new` — auto-accept new host keys (TOFU), reject changed keys
- `-o BatchMode=yes` — fail immediately if interactive auth is needed; no password prompts

## Terminal restore

When opening a terminal for a completed SSH task from the desktop UI, the runner produces a `TerminalSpec` with `command: 'ssh'` and the target's connection args. This opens an interactive SSH session to the remote host.

## Security notes

- SSH keys must never be committed to the repository. `sshKeyPath` is a local filesystem path on the owner host, not key content.
- `poolId` and SSH target IDs are non-secret aliases; they contain no credentials.
- `BatchMode=yes` ensures SSH never falls back to interactive password prompts.
- The owner host is the control plane. Protect its database, config, web token, and SSH private keys as operator credentials.
