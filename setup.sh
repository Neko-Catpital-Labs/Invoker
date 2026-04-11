#!/usr/bin/env bash
# First-time project setup for Invoker.
# Detects OS and installs prerequisites, then runs pnpm install.
set -e

REQUIRED_NODE_MAJOR=22

echo "==> Invoker project setup"
echo ""

# --- OS detection ---
OS="$(uname)"
case "$OS" in
  Darwin) echo "Detected macOS" ;;
  Linux)  echo "Detected Linux" ;;
  *)      echo "Unsupported OS: $OS"; exit 1 ;;
esac
echo ""

# --- Helper: check if a command exists ---
has() { command -v "$1" >/dev/null 2>&1; }

# --- Node.js 22.x ---
echo "==> Checking Node.js..."
NEED_NODE=false

if has node; then
  NODE_MAJOR=$(node -e "process.stdout.write(String(process.versions.node.split('.')[0]))")
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
      echo "    ERROR: Homebrew is required to install Node.js on macOS."
      echo "    Install it from https://brew.sh and re-run this script."
      exit 1
    fi
    brew install "node@$REQUIRED_NODE_MAJOR"
    # brew link if not already linked
    brew link --overwrite "node@$REQUIRED_NODE_MAJOR" 2>/dev/null || true
  else
    # Linux
    if has apt-get; then
      echo "    Using NodeSource apt repository..."
      curl -fsSL "https://deb.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo -E bash -
      sudo apt-get install -y nodejs
    elif has dnf; then
      echo "    Using NodeSource rpm repository..."
      curl -fsSL "https://rpm.nodesource.com/setup_${REQUIRED_NODE_MAJOR}.x" | sudo bash -
      sudo dnf install -y nodejs
    else
      echo "    ERROR: Could not detect apt or dnf. Please install Node.js $REQUIRED_NODE_MAJOR.x manually."
      exit 1
    fi
  fi

  # Verify
  if ! has node; then
    echo "    ERROR: Node.js installation failed. Please install Node.js $REQUIRED_NODE_MAJOR.x manually."
    exit 1
  fi
  echo "    Installed: Node.js $(node --version)"
fi
echo ""

# --- pnpm via corepack ---
echo "==> Checking pnpm..."
if has pnpm; then
  echo "    OK: pnpm $(pnpm --version)"
else
  echo "    pnpm not found. Installing via corepack..."
  corepack enable
  corepack prepare pnpm@latest --activate
  echo "    Installed: pnpm $(pnpm --version)"
fi
echo ""

# --- xdotool (Linux only, for scripts/focus-invoker.sh) ---
if [ "$OS" = "Linux" ]; then
  echo "==> Checking xdotool (optional, for scripts/focus-invoker.sh)..."
  if has xdotool; then
    echo "    OK: xdotool found"
  else
    echo "    xdotool not found. Installing..."
    if has apt-get; then
      sudo apt-get install -y xdotool
    elif has dnf; then
      sudo dnf install -y xdotool
    else
      echo "    WARNING: Could not install xdotool. scripts/focus-invoker.sh won't work without it."
    fi
  fi
  echo ""
fi

# --- pnpm install ---
echo "==> Running pnpm install (triggers postinstall → native module rebuild for Electron ABI)..."
pnpm install
echo ""

# --- Cursor CLI ---
echo "==> Checking Cursor CLI..."
if has cursor; then
  echo "    OK: cursor CLI on PATH"
  cursor --version | sed 's/^/    /'
else
  CURSOR_APP_CLI="/Applications/Cursor.app/Contents/Resources/app/bin/cursor"
  if [ "$OS" = "Darwin" ] && [ -x "$CURSOR_APP_CLI" ]; then
    echo "    Cursor app found, but 'cursor' is not on PATH."
    echo "    Fallback supported: set CURSOR_COMMAND in .env"
    echo "    CURSOR_COMMAND=$CURSOR_APP_CLI"
  elif [ "$OS" = "Darwin" ] && has brew; then
    echo "    Cursor CLI not found. Attempting install via Homebrew cask..."
    brew install --cask cursor || true
    if has cursor; then
      echo "    Installed: cursor CLI on PATH"
      cursor --version | sed 's/^/    /'
    elif [ -x "$CURSOR_APP_CLI" ]; then
      echo "    Cursor app installed, but PATH still missing CLI."
      echo "    Set CURSOR_COMMAND in .env:"
      echo "    CURSOR_COMMAND=$CURSOR_APP_CLI"
    else
      echo "    WARNING: Cursor CLI is still unavailable."
      echo "    Install Cursor and set CURSOR_COMMAND in .env."
    fi
  else
    echo "    WARNING: Cursor CLI not found."
    echo "    Install Cursor CLI and set CURSOR_COMMAND in .env if needed."
  fi
fi
echo ""

# --- Summary ---
echo "============================================"
echo "  Setup complete!"
echo ""
echo "  Node.js: $(node --version)"
echo "  pnpm:    $(pnpm --version)"
if has cursor; then
  echo "  cursor:  $(command -v cursor)"
else
  echo "  cursor:  not on PATH (fallback via CURSOR_COMMAND is supported)"
fi
if [ "$OS" = "Linux" ]; then
  if has xdotool; then
    echo "  xdotool: installed"
  else
    echo "  xdotool: not installed (optional)"
  fi
fi
echo ""
echo "  Next steps:"
echo "    ./run.sh          — build and launch Invoker"
echo "    pnpm test         — run tests (in any package dir)"
echo "============================================"
