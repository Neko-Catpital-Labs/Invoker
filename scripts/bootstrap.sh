#!/usr/bin/env bash
# Optional Node bootstrap for Invoker. Ensures Node 26, then runs the
# public invoker-cli quick-install one-liner. Prefer:
#   npx @neko-catpital-labs/invoker-cli@latest install
# when Node is already installed.
# Does NOT write Slack tokens or remote machines.
set -euo pipefail

REQUIRED_NODE_MAJOR=26

usage() {
  cat <<'EOF'
Usage: curl -fsSL https://raw.githubusercontent.com/Neko-Catpital-Labs/Invoker/master/scripts/bootstrap.sh | bash

Optional wrapper: installs Node.js 26.x if needed, then runs:
  npx @neko-catpital-labs/invoker-cli@latest install

Prefer that npx one-liner directly when Node 26 is already available.
Does not configure Slack or remote machines.
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

# Download a NodeSource setup script to a local file and inspect it before
# executing, instead of piping curl output directly into a privileged shell.
run_nodesource_setup() {
  local url="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  trap 'rm -f "$tmp"' RETURN
  curl -fsSL "$url" -o "$tmp"
  if [ ! -s "$tmp" ] || ! head -c 2 "$tmp" | grep -q '^#!'; then
    echo "    ERROR: Downloaded NodeSource setup script failed validation." >&2
    exit 1
  fi
  sudo "$@" bash "$tmp"
}

OS="$(uname -s)"
case "$OS" in
  Darwin|Linux) ;;
  *)
    echo "Unsupported OS: $OS" >&2
    exit 1
    ;;
esac

echo "==> Invoker bootstrap (Node ensure → invoker-cli install)"
echo ""

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
      run_nodesource_setup "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" -E
      sudo apt-get install -y nodejs
    elif has dnf; then
      run_nodesource_setup "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x"
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
  INSTALLED_NODE_MAJOR="$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")"
  if [ "$INSTALLED_NODE_MAJOR" != "$REQUIRED_NODE_MAJOR" ]; then
    echo "    ERROR: Node.js $REQUIRED_NODE_MAJOR.x was installed, but 'node' on PATH is still v$(node --version | tr -d v)." >&2
    if [ "$OS" = "Darwin" ]; then
      echo "    Homebrew likely failed to link node@$REQUIRED_NODE_MAJOR ahead of another Node on PATH." >&2
      echo "    Run: brew link --overwrite node@$REQUIRED_NODE_MAJOR" >&2
    else
      echo "    Another Node.js install earlier on PATH is shadowing the new one; fix PATH and re-run." >&2
    fi
    exit 1
  fi
  echo "    Installed: Node.js $(node --version)"
fi
echo ""

if ! has npm; then
  echo "ERROR: npm not found after Node install." >&2
  exit 1
fi

echo "==> Running npx @neko-catpital-labs/invoker-cli@latest install..."
run_cli npx --yes @neko-catpital-labs/invoker-cli@latest install
