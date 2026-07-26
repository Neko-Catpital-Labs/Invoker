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

# Temp directory for SSH key pair and config.
_INVOKER_E2E_SSH_TMPDIR=""

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
  local keyfile="$_INVOKER_E2E_SSH_TMPDIR/id_ed25519"
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

  export INVOKER_E2E_SSH_KEY="$keyfile"
}

# --------------------------------------------------------------------------- #
# Remove temp key from authorized_keys, delete temp dir.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_cleanup_keys() {
  local authorized_keys="${_INVOKER_E2E_SSH_HOME:-}/.ssh/authorized_keys"
  local env_path="${_INVOKER_E2E_SSH_HOME:-}/.invoker/env.sh"
  if [ -n "${_INVOKER_E2E_SSH_TAG:-}" ] && [ -f "$authorized_keys" ]; then
    grep -v "$_INVOKER_E2E_SSH_TAG" "$authorized_keys" > "${authorized_keys}.tmp" || true
    mv "${authorized_keys}.tmp" "$authorized_keys"
    chmod 600 "$authorized_keys"
  fi
  if [ -n "${_INVOKER_E2E_SSH_TAG:-}" ] && [ -f "$env_path" ]; then
    # Remove the marker line and the following PATH export we appended.
    awk -v marker="# invoker-e2e-ssh-pnpm-path ${_INVOKER_E2E_SSH_TAG}" '
      $0 == marker { skip=1; next }
      skip && /^export PATH=/ { skip=0; next }
      { skip=0; print }
    ' "$env_path" > "${env_path}.tmp" || true
    mv "${env_path}.tmp" "$env_path"
  fi
  rm -rf "${_INVOKER_E2E_SSH_TMPDIR:-}" 2>/dev/null || true
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

# --------------------------------------------------------------------------- #
# Write temp JSON config with a localhost-e2e execution pool.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_write_config() {
  local config_file="$_INVOKER_E2E_SSH_TMPDIR/invoker-config.json"
  local remote_home
  local provision_cmd
  remote_home="$_INVOKER_E2E_SSH_TMPDIR/remote-invoker-home"
  provision_cmd="$(invoker_e2e_ssh_provision_command)"

  cat > "$config_file" <<EOJSON
{
  "executionPools": {
    "localhost-e2e": {
      "members": [
        { "type": "ssh", "id": "localhost-e2e" }
      ]
    }
  },
  "remoteTargets": {
    "localhost-e2e": {
      "host": "localhost",
      "user": "$_INVOKER_E2E_SSH_USER",
      "sshKeyPath": "$INVOKER_E2E_SSH_KEY",
      "port": 22,
      "managedWorkspaces": true,
      "remoteInvokerHome": "$remote_home",
      "provisionCommand": "$provision_cmd"
    }
  }
}
EOJSON

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
  if ! ssh -o BatchMode=yes \
           -o ConnectTimeout=5 \
           -o StrictHostKeyChecking=no \
           -i "$INVOKER_E2E_SSH_KEY" \
           "$_INVOKER_E2E_SSH_USER@localhost" true 2>/dev/null; then
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
# Ensure host pnpm/node are on the remote login-shell PATH.
# SshExecutor uses `bash -l` and does not forward the host PATH.
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

  ssh -o BatchMode=yes \
      -o ConnectTimeout=5 \
      -o StrictHostKeyChecking=no \
      -i "$INVOKER_E2E_SSH_KEY" \
      "$_INVOKER_E2E_SSH_USER@localhost" \
      "bash -s" <<EOF
set -euo pipefail
marker='# invoker-e2e-ssh-pnpm-path ${_INVOKER_E2E_SSH_TAG}'
mkdir -p "\$HOME/.invoker"
touch "\$HOME/.invoker/env.sh"
if ! grep -Fq "\$marker" "\$HOME/.invoker/env.sh" 2>/dev/null; then
  {
    printf '%s\n' "\$marker"
    printf 'export PATH="%s:%s:\$PATH"\n' '${node_dir}' '${pnpm_dir}'
  } >> "\$HOME/.invoker/env.sh"
fi
EOF

  # Verify via non-login bash — matches the executor sourcing ~/.invoker/env.sh explicitly.
  if ! ssh -o BatchMode=yes \
           -o ConnectTimeout=5 \
           -o StrictHostKeyChecking=no \
           -i "$INVOKER_E2E_SSH_KEY" \
           "$_INVOKER_E2E_SSH_USER@localhost" \
           "bash -s" <<'EOF' >/dev/null 2>&1; then
. "$HOME/.invoker/env.sh"
command -v pnpm >/dev/null
pnpm --version
EOF
    echo "ERROR: 'pnpm' not found after sourcing ~/.invoker/env.sh." >&2
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
