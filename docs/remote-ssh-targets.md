# Remote SSH Targets

Execute Invoker tasks on remote machines via SSH key-based authentication.

## Overview

The SSH executor (`executorType: ssh`) runs task commands on remote hosts over SSH. Authentication is exclusively key-based — no password auth or `sshpass` dependency is required.

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
      "provisionCommand": "pnpm install --frozen-lockfile"
    },
    "staging-server-b": {
      "host": "192.168.1.101",
      "user": "deploy",
      "sshKeyPath": "/home/user/.ssh/id_staging_b",
      "port": 22,
      "managedWorkspaces": true,
      "remoteInvokerHome": "~/.invoker",
      "provisionCommand": "pnpm install --frozen-lockfile"
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

## Multiple SSH Targets

You can configure as many remote targets as you want under `remoteTargets`. Each task picks one by `remoteTargetId`.

```yaml
name: "Run tasks on multiple remotes"
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: master
tasks:
  - id: check-a
    description: "Run tests on remote A"
    command: "pnpm test"
    executorType: ssh
    remoteTargetId: staging-server

  - id: check-b
    description: "Run tests on remote B"
    command: "pnpm test"
    executorType: ssh
    remoteTargetId: staging-server-b
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
    executorType: ssh
    remoteTargetId: staging-server
    dependencies: []

  - id: run-migrations
    description: "Run database migrations on staging"
    command: "cd /opt/app && ./migrate.sh"
    executorType: ssh
    remoteTargetId: staging-server
    dependencies:
      - health-check
```

### Task fields

- `executorType: ssh` — selects the SSH executor
- `remoteTargetId: <id>` — references a key in `remoteTargets` config

Both fields are required for SSH tasks. The executor validates at runtime that the `remoteTargetId` exists in config and throws a clear error if it's missing.

## How It Works

1. The plan parser reads `executorType` and `remoteTargetId` from YAML and carries them through to `TaskConfig`.
2. When `TaskRunner.selectExecutor()` sees `executorType: ssh`, it looks up the `remoteTargetId` in the `remoteTargets` config map.
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
- The `remoteTargetId` stored in the task config and SQLite database is a non-secret alias — it contains no credentials.
- `BatchMode=yes` ensures SSH never falls back to interactive password prompts.
