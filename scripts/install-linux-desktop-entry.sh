#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP_FILE="$APP_DIR/invoker.desktop"
ICON_PATH="$REPO_ROOT/packages/app/dist/assets/icons/png/256x256.png"

mkdir -p "$APP_DIR"

cat >"$DESKTOP_FILE" <<EOF
[Desktop Entry]
Version=1.0
Type=Application
Name=Invoker
Comment=Invoker Electron app
Exec=$REPO_ROOT/run.sh
Path=$REPO_ROOT
Icon=$ICON_PATH
Terminal=false
Categories=Development;
StartupNotify=true
StartupWMClass=invoker
X-GNOME-WMClass=invoker
EOF

if command -v desktop-file-validate >/dev/null 2>&1; then
  desktop-file-validate "$DESKTOP_FILE"
fi

printf '%s\n' "$DESKTOP_FILE"
