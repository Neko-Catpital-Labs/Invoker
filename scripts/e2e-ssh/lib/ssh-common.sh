#!/usr/bin/env bash
# Shared SSH E2E infrastructure. Sources base common.sh, adds SSH key management
# and config isolation for cross-executor tests against localhost sshd.
#
# Prerequisites (one-time setup):
#   1. openssh-server installed and running: sudo apt install openssh-server
#
# Usage:
#   source "$(dirname "$0")/../lib/ssh-common.sh"
#   invoker_e2e_ssh_init
#   trap invoker_e2e_ssh_full_cleanup EXIT

_INVOKER_E2E_SSH_LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
_INVOKER_E2E_SSH_ROOT="$(cd "$_INVOKER_E2E_SSH_LIB_DIR/.." && pwd)"

# Source base helpers from e2e-dry-run.
# shellcheck disable=SC1091
source "$_INVOKER_E2E_SSH_ROOT/../e2e-dry-run/lib/common.sh"

# Override timeout for SSH tests (clone + fetch + worktree provision is slow).
INVOKER_E2E_TIMEOUT="${INVOKER_E2E_TIMEOUT:-300}"

# Tag for authorized_keys entries created by this process.
_INVOKER_E2E_SSH_TAG="invoker-e2e-ssh-$$"

# Temp directory for SSH key pair, config, and remote invoker home.
_INVOKER_E2E_SSH_TMPDIR=""
_INVOKER_E2E_SSH_REMOTE_HOME=""
_INVOKER_E2E_SSH_KNOWN_HOSTS=""

# SSH login user and passwd-backed home directory used by sshd.
_INVOKER_E2E_SSH_USER=""
_INVOKER_E2E_SSH_HOME=""

# --------------------------------------------------------------------------- #
# Test if sshd is listening on localhost port 22 (3s timeout).
# Only checks TCP reachability — auth is tested later after key setup.
# Returns 0 if sshd is reachable, 1 otherwise.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_available() {
  timeout 3 bash -c 'echo > /dev/tcp/localhost/22' 2>/dev/null
}

invoker_e2e_ssh_resolve_home() {
  local user="$1"
  local resolved_home=""
  if command -v getent >/dev/null 2>&1; then
    resolved_home="$(getent passwd "$user" | cut -d: -f6)"
  fi
  if [ -z "$resolved_home" ]; then
    resolved_home="$(eval "printf '%s' ~$user")"
  fi
  printf '%s\n' "$resolved_home"
}

# --------------------------------------------------------------------------- #
# Generate temp ed25519 key pair, add public key to authorized_keys.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_setup_keys() {
  _INVOKER_E2E_SSH_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-ssh.XXXXXX")"
  _INVOKER_E2E_SSH_REMOTE_HOME="$_INVOKER_E2E_SSH_TMPDIR/remote-invoker-home"
  local keyfile="$_INVOKER_E2E_SSH_TMPDIR/id_ed25519"
  _INVOKER_E2E_SSH_KNOWN_HOSTS="$_INVOKER_E2E_SSH_TMPDIR/known_hosts"
  _INVOKER_E2E_SSH_USER="$(whoami)"
  _INVOKER_E2E_SSH_HOME="$(invoker_e2e_ssh_resolve_home "$_INVOKER_E2E_SSH_USER")"

  if [ -z "$_INVOKER_E2E_SSH_HOME" ]; then
    echo "ERROR: unable to resolve passwd home for SSH user '$_INVOKER_E2E_SSH_USER'." >&2
    return 1
  fi

  # -C sets the comment field to our PID-tagged identifier for cleanup.
  ssh-keygen -t ed25519 -f "$keyfile" -N "" -C "$_INVOKER_E2E_SSH_TAG" -q

  # sshd reads authorized_keys from the account's passwd home, which may differ
  # from $HOME inside CI containers.
  mkdir -p "$_INVOKER_E2E_SSH_HOME/.ssh"
  chmod 700 "$_INVOKER_E2E_SSH_HOME/.ssh"
  touch "$_INVOKER_E2E_SSH_HOME/.ssh/authorized_keys"
  chmod 600 "$_INVOKER_E2E_SSH_HOME/.ssh/authorized_keys"

  # Append public key (comment already contains tag).
  cat "${keyfile}.pub" >> "$_INVOKER_E2E_SSH_HOME/.ssh/authorized_keys"

  touch "$_INVOKER_E2E_SSH_KNOWN_HOSTS"
  chmod 600 "$_INVOKER_E2E_SSH_KNOWN_HOSTS"

  export INVOKER_E2E_SSH_KEY="$keyfile"
  export INVOKER_SSH_USER_KNOWN_HOSTS_FILE="$_INVOKER_E2E_SSH_KNOWN_HOSTS"
}

invoker_e2e_ssh_run() {
  ssh -o BatchMode=yes \
      -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=accept-new \
      -o "UserKnownHostsFile=$INVOKER_SSH_USER_KNOWN_HOSTS_FILE" \
      -i "$INVOKER_E2E_SSH_KEY" \
      "$_INVOKER_E2E_SSH_USER@localhost" \
      "$@"
}

invoker_e2e_ssh_prune_login_path_file() {
  local env_path="$1"
  [ -f "$env_path" ] || return 0
  awk '
    /# invoker-e2e-ssh-pnpm-path / {
      prefix = $0
      sub(/[[:space:]]*# invoker-e2e-ssh-pnpm-path .*/, "", prefix)
      if (prefix != "") print prefix
      skip_path = 1
      next
    }
    skip_path && /^export PATH=/ {
      skip_path = 0
      next
    }
    {
      skip_path = 0
      print
    }
  ' "$env_path" > "${env_path}.tmp" || true
  mv "${env_path}.tmp" "$env_path"
  chmod 600 "$env_path"
}

# --------------------------------------------------------------------------- #
# Remove temp key from authorized_keys, delete temp dir.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_cleanup_keys() {
  local authorized_keys="${_INVOKER_E2E_SSH_HOME:-}/.ssh/authorized_keys"
  local env_path="${_INVOKER_E2E_SSH_REMOTE_HOME:-}/env.sh"
  if [ -n "${_INVOKER_E2E_SSH_TAG:-}" ] && [ -f "$authorized_keys" ]; then
    grep -v "$_INVOKER_E2E_SSH_TAG" "$authorized_keys" > "${authorized_keys}.tmp" || true
    mv "${authorized_keys}.tmp" "$authorized_keys"
    chmod 600 "$authorized_keys"
  fi
  if [ -n "${_INVOKER_E2E_SSH_TAG:-}" ] && [ -f "$env_path" ]; then
    invoker_e2e_ssh_prune_login_path_file "$env_path"
  fi
  rm -rf "${_INVOKER_E2E_SSH_TMPDIR:-}" 2>/dev/null || true
  unset INVOKER_SSH_USER_KNOWN_HOSTS_FILE
}

# --------------------------------------------------------------------------- #
# Print the repo-owned SSH provision command used by managed remote worktrees.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_provision_command() {
  (
    cd "$INVOKER_E2E_REPO_ROOT"
    bash scripts/provision-ssh-worker.sh print-provision-command
  )
}

invoker_e2e_ssh_config_provision_command() {
  printf 'INVOKER_SKIP_SHELL_HOOKS=1 %s\n' "$(invoker_e2e_ssh_provision_command)"
}

# --------------------------------------------------------------------------- #
# Write temp JSON config with a localhost-e2e execution pool.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_write_config() {
  local config_file="$_INVOKER_E2E_SSH_TMPDIR/invoker-config.json"
  local remote_home
  local provision_cmd
  remote_home="$_INVOKER_E2E_SSH_REMOTE_HOME"
  provision_cmd="$(invoker_e2e_ssh_config_provision_command)"

  node - "$config_file" "$_INVOKER_E2E_SSH_USER" "$INVOKER_E2E_SSH_KEY" "$remote_home" "$provision_cmd" <<'NODE'
const { writeFileSync } = require('node:fs');
const [configFile, user, sshKeyPath, remoteInvokerHome, provisionCommand] = process.argv.slice(2);
writeFileSync(configFile, `${JSON.stringify({
  executionPools: {
    'localhost-e2e': {
      members: [
        { type: 'ssh', id: 'localhost-e2e' },
      ],
    },
  },
  remoteTargets: {
    'localhost-e2e': {
      host: 'localhost',
      user,
      sshKeyPath,
      port: 22,
      managedWorkspaces: true,
      remoteInvokerHome,
      provisionCommand,
    },
  },
}, null, 2)}\n`);
NODE

  export INVOKER_REPO_CONFIG_PATH="$config_file"
}

# --------------------------------------------------------------------------- #
# Combined: setup keys + path + config + verify connection + verify pnpm.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_init() {
  invoker_e2e_init
  invoker_e2e_ssh_setup_keys
  invoker_e2e_ssh_write_config

  # Verify SSH works with the generated key.
  if ! invoker_e2e_ssh_run true 2>/dev/null; then
    echo "ERROR: SSH to localhost with generated key failed. Aborting." >&2
    invoker_e2e_ssh_cleanup_keys
    return 1
  fi

  if ! invoker_e2e_ssh_install_login_path; then
    invoker_e2e_ssh_cleanup_keys
    return 1
  fi
}

# --------------------------------------------------------------------------- #
# Ensure host pnpm/node are on the remote task PATH.
# SshExecutor uses a non-login shell and sources remoteInvokerHome/env.sh.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_install_login_path() {
  local pnpm_bin node_bin pnpm_dir node_dir
  pnpm_bin="$(command -v pnpm || true)"
  node_bin="$(command -v node || true)"
  if [ -z "$pnpm_bin" ] || [ -z "$node_bin" ]; then
    echo "ERROR: host pnpm/node not found; cannot provision remote login PATH." >&2
    return 1
  fi
  pnpm_dir="$(cd "$(dirname "$pnpm_bin")" && pwd)"
  node_dir="$(cd "$(dirname "$node_bin")" && pwd)"

  mkdir -p "$_INVOKER_E2E_SSH_REMOTE_HOME"
  touch "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
  chmod 600 "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
  invoker_e2e_ssh_prune_login_path_file "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
  if ! grep -Fq "# invoker-e2e-ssh-pnpm-path ${_INVOKER_E2E_SSH_TAG}" "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh" 2>/dev/null; then
    {
      printf '%s\n' "# invoker-e2e-ssh-pnpm-path ${_INVOKER_E2E_SSH_TAG}"
      printf 'export PATH="%s:%s:$PATH"\n' "$node_dir" "$pnpm_dir"
    } >> "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
  fi

  # Verify via non-login bash — matches the executor sourcing remoteInvokerHome/env.sh explicitly.
  if ! invoker_e2e_ssh_run "bash -s" <<EOF >/dev/null 2>&1; then
. "$_INVOKER_E2E_SSH_REMOTE_HOME/env.sh"
command -v pnpm >/dev/null
pnpm --version
EOF
    echo "ERROR: 'pnpm' not found after sourcing $_INVOKER_E2E_SSH_REMOTE_HOME/env.sh." >&2
    return 1
  fi
}

# --------------------------------------------------------------------------- #
# Combined: prune worktrees + cleanup path + cleanup keys + base cleanup.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_full_cleanup() {
  # Prune worktrees (both local and those created by SSH executor on localhost).
  git -C "$INVOKER_E2E_REPO_ROOT" worktree prune 2>/dev/null || true
  # Clean up SSH keys and config.
  invoker_e2e_ssh_cleanup_keys
  # Run base cleanup (kill Electron, clean temp dirs).
  invoker_e2e_cleanup
}
