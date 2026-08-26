#!/usr/bin/env bash
# One-command public onboarding for Invoker.
# Installs Node if needed, npm packages, doctor --fix, and setup --yes.
# Does NOT write Slack tokens or remote machines.
set -euo pipefail

REQUIRED_NODE_MAJOR=26

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://raw.githubusercontent.com/Neko-Catpital-Labs/Invoker/master/scripts/bootstrap.sh | bash

Installs @neko-catpital-labs/invoker-cli and invoker-ui, runs doctor --fix,
then invoker-cli setup --yes (skills + MCP into Claude/Cursor/Codex/OMP).

Does not configure Slack or remote machines. Does not auto-install Cursor/OMP.
EOF
}

if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  usage
  exit 0
fi

has() { command -v "$1" >/dev/null 2>&1; }

# Child CLIs must not read from the curl|bash stdin pipe.
run_cli() {
  "$@" </dev/null
}

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "==> Invoker bootstrap"
echo ""

# --- Node.js 26.x ---
echo "==> Checking Node.js..."
NEED_NODE=false
if has node; then
  NODE_MAJOR="$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")"
  if [ "$NODE_MAJOR" != "$REQUIRED_NODE_MAJOR" ]; then
    echo "    Found Node.js v$(node --version | tr -d v), but Node $REQUIRED_NODE_MAJOR.x is required."
    NEED_NODE=true
  else
    echo "    OK: Node.js $(node --version)"
  fi
else
  echo "    Node.js not found."
  NEED_NODE=true
fi

if [ "$NEED_NODE" = true ]; then
  echo "    Installing Node.js $REQUIRED_NODE_MAJOR.x..."
  if [ "$OS" = "Darwin" ]; then
    if ! has brew; then
      echo "    ERROR: Homebrew is required to install Node.js on macOS." >&2
      echo "    Install it from https://brew.sh and re-run this script." >&2
      exit 1
    fi
    brew install "node@$REQUIRED_NODE_MAJOR"
    brew link --overwrite "node@$REQUIRED_NODE_MAJOR" 2>/dev/null || true
  else
    if has apt-get; then
      curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
      sudo apt-get install -y nodejs
    elif has dnf; then
      curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo bash -
      sudo dnf install -y nodejs
    else
      echo "    ERROR: Could not detect apt or dnf. Install Node.js $REQUIRED_NODE_MAJOR.x manually." >&2
      exit 1
    fi
  fi
  if ! has node; then
    echo "    ERROR: Node.js installation failed." >&2
    exit 1
  fi
  echo "    Installed: Node.js $(node --version)"
fi
echo ""

if ! has npm; then
  echo "ERROR: npm not found after Node install." >&2
  exit 1
fi

# --- npm packages ---
echo "==> Installing Invoker npm packages..."
run_cli npm install -g @neko-catpital-labs/invoker-cli @neko-catpital-labs/invoker-ui
if ! has invoker-cli; then
  echo "ERROR: invoker-cli not on PATH after npm install." >&2
  exit 1
fi
echo "    OK: invoker-cli $(invoker-cli --version 2>/dev/null || echo installed)"
echo ""

# --- doctor + setup ---
# Soft-fail: optional tools (e.g. Cursor) or host config may leave doctor/setup
# non-zero even after skills + MCP are installed. Hard-fail only if CLI missing.
echo "==> Running invoker-cli doctor --fix..."
run_cli invoker-cli doctor --fix || true
echo ""

echo "==> Running invoker-cli setup --yes..."
SETUP_STATUS=0
run_cli invoker-cli setup --yes || SETUP_STATUS=$?
if [ "$SETUP_STATUS" -ne 0 ]; then
  echo "    WARN: invoker-cli setup exited $SETUP_STATUS (often optional tool/preset gaps)."
  echo "    Skills/MCP may still be installed. Re-run: invoker-cli doctor && invoker-cli setup"
fi
echo ""

cat <<'EOF'
============================================
  Bootstrap complete.

  Default Invoker owner: local (invoker-cli mcp).
  In Claude / Cursor / Codex / OMP chat, ask to
  plan and run durable work through Invoker.
  Name a host or IP in chat to use a remote
  Invoker (agent probes SSH, then retargets MCP).

  Optional next:
    invoker-cli setup slack
    invoker-cli setup machines
    invoker-ui

  Desktop binary-only path remains:
    curl -fsSL .../scripts/install.sh | bash
============================================
EOF
