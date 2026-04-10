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

# Track whether we injected a PATH line into ~/.bashrc.
_INVOKER_E2E_BASHRC_PATCHED=""

# --------------------------------------------------------------------------- #
# Test if sshd is listening on localhost port 22 (3s timeout).
# Only checks TCP reachability — auth is tested later after key setup.
# Returns 0 if sshd is reachable, 1 otherwise.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_available() {
  timeout 3 bash -c 'echo > /dev/tcp/localhost/22' 2>/dev/null
}

# --------------------------------------------------------------------------- #
# Generate temp ed25519 key pair, add public key to authorized_keys.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_setup_keys() {
  _INVOKER_E2E_SSH_TMPDIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-e2e-ssh.XXXXXX")"
  local keyfile="$_INVOKER_E2E_SSH_TMPDIR/id_ed25519"

  # -C sets the comment field to our PID-tagged identifier for cleanup.
  ssh-keygen -t ed25519 -f "$keyfile" -N "" -C "$_INVOKER_E2E_SSH_TAG" -q

  # Ensure ~/.ssh/authorized_keys exists with correct permissions.
  mkdir -p ~/.ssh
  chmod 700 ~/.ssh
  touch ~/.ssh/authorized_keys
  chmod 600 ~/.ssh/authorized_keys

  # Append public key (comment already contains tag).
  cat "${keyfile}.pub" >> ~/.ssh/authorized_keys

  export INVOKER_E2E_SSH_KEY="$keyfile"
}

# --------------------------------------------------------------------------- #
# Inject PATH export at the top of ~/.bashrc so non-interactive SSH sessions
# (which bash sources ~/.bashrc for, but Ubuntu's default guard blocks) get
# the full PATH including pnpm/node. Tagged with our PID for safe cleanup.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_setup_path() {
  local bashrc="$HOME/.bashrc"
  local tag="# $_INVOKER_E2E_SSH_TAG"
  local path_line="export PATH=\"$PATH\" $tag"

  if [ -f "$bashrc" ]; then
    # Prepend the PATH export before the non-interactive guard.
    local tmp
    tmp="$(mktemp)"
    echo "$path_line" > "$tmp"
    cat "$bashrc" >> "$tmp"
    mv "$tmp" "$bashrc"
  else
    echo "$path_line" > "$bashrc"
  fi
  _INVOKER_E2E_BASHRC_PATCHED=1
}

# --------------------------------------------------------------------------- #
# Remove the injected PATH line from ~/.bashrc.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_cleanup_path() {
  if [ -n "${_INVOKER_E2E_BASHRC_PATCHED:-}" ]; then
    local bashrc="$HOME/.bashrc"
    if [ -f "$bashrc" ]; then
      grep -v "$_INVOKER_E2E_SSH_TAG" "$bashrc" > "$bashrc.tmp" || true
      mv "$bashrc.tmp" "$bashrc"
    fi
    _INVOKER_E2E_BASHRC_PATCHED=""
  fi
}

# --------------------------------------------------------------------------- #
# Remove temp key from authorized_keys, delete temp dir.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_cleanup_keys() {
  if [ -n "${_INVOKER_E2E_SSH_TAG:-}" ] && [ -f ~/.ssh/authorized_keys ]; then
    grep -v "$_INVOKER_E2E_SSH_TAG" ~/.ssh/authorized_keys > ~/.ssh/authorized_keys.tmp || true
    mv ~/.ssh/authorized_keys.tmp ~/.ssh/authorized_keys
    chmod 600 ~/.ssh/authorized_keys
  fi
  rm -rf "${_INVOKER_E2E_SSH_TMPDIR:-}" 2>/dev/null || true
}

# --------------------------------------------------------------------------- #
# Write temp JSON config with localhost-e2e remote target.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_write_config() {
  local config_file="$_INVOKER_E2E_SSH_TMPDIR/invoker-config.json"
  local current_user
  current_user="$(whoami)"

  cat > "$config_file" <<EOJSON
{
  "remoteTargets": {
    "localhost-e2e": {
      "host": "localhost",
      "user": "$current_user",
      "sshKeyPath": "$INVOKER_E2E_SSH_KEY",
      "port": 22
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
  invoker_e2e_ssh_setup_path
  invoker_e2e_ssh_write_config

  # Verify SSH works with the generated key.
  if ! ssh -o BatchMode=yes \
           -o ConnectTimeout=5 \
           -o StrictHostKeyChecking=no \
           -i "$INVOKER_E2E_SSH_KEY" \
           "$(whoami)@localhost" true 2>/dev/null; then
    echo "ERROR: SSH to localhost with generated key failed. Aborting." >&2
    invoker_e2e_ssh_cleanup_path
    invoker_e2e_ssh_cleanup_keys
    return 1
  fi

  # Verify pnpm is reachable via non-interactive SSH session.
  if ! ssh -o BatchMode=yes \
           -o ConnectTimeout=5 \
           -o StrictHostKeyChecking=no \
           -i "$INVOKER_E2E_SSH_KEY" \
           "$(whoami)@localhost" 'pnpm --version' >/dev/null 2>&1; then
    echo "ERROR: 'pnpm' not found in non-interactive SSH session PATH." >&2
    echo "  ~/.bashrc PATH injection did not propagate." >&2
    echo "  Check that bash sources ~/.bashrc for non-interactive SSH sessions." >&2
    invoker_e2e_ssh_cleanup_path
    invoker_e2e_ssh_cleanup_keys
    return 1
  fi
}

# --------------------------------------------------------------------------- #
# Combined: prune worktrees + cleanup path + cleanup keys + base cleanup.
# --------------------------------------------------------------------------- #
invoker_e2e_ssh_full_cleanup() {
  # Prune worktrees (both local and those created by SSH executor on localhost).
  git -C "$INVOKER_E2E_REPO_ROOT" worktree prune 2>/dev/null || true
  # Clean up bashrc PATH injection.
  invoker_e2e_ssh_cleanup_path
  # Clean up SSH keys and config.
  invoker_e2e_ssh_cleanup_keys
  # Run base cleanup (kill Electron, clean temp dirs).
  invoker_e2e_cleanup
}
