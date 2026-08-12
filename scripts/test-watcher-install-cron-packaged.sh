#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
INSTALL_SRC="$REPO_ROOT/packages/watcher/deploy/install.sh"

TMP="$(mktemp -d)"
cleanup() {
  pkill -f "$TMP/install.sh" 2>/dev/null || true
  pkill -f "$TMP/bin/sleep" 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

HOME_DIR="$TMP/home"
BIN_DIR="$TMP/bin"
mkdir -p "$HOME_DIR" "$BIN_DIR"

cp "$INSTALL_SRC" "$TMP/install.sh"
chmod +x "$TMP/install.sh"
ln -s /bin/grep "$BIN_DIR/grep"
ln -s /bin/mkdir "$BIN_DIR/mkdir"

cat > "$BIN_DIR/node" <<'EOF'
#!/bin/bash
exit 0
EOF
chmod +x "$BIN_DIR/node"

cat > "$BIN_DIR/invoker-watcher" <<'EOF'
#!/bin/bash
pwd >> "$FAKE_WATCHER_PWD_LOG"
echo "watcher stdout"
exit 0
EOF
chmod +x "$BIN_DIR/invoker-watcher"

cat > "$BIN_DIR/crontab" <<'EOF'
#!/bin/bash
if [ "${1:-}" = "-l" ]; then
  exit 0
fi
/bin/cat > "$FAKE_CRONTAB_OUT"
EOF
chmod +x "$BIN_DIR/crontab"

cat > "$BIN_DIR/sleep" <<'EOF'
#!/bin/bash
printf '%s\n' "$$" > "$FAKE_SLEEP_PID"
/bin/sleep 300
EOF
chmod +x "$BIN_DIR/sleep"

export HOME="$HOME_DIR"
export PATH="$BIN_DIR"
export FAKE_CRONTAB_OUT="$TMP/crontab.out"
export FAKE_WATCHER_PWD_LOG="$TMP/watcher-pwd.log"
export FAKE_SLEEP_PID="$TMP/sleep.pid"

/bin/bash "$TMP/install.sh" > "$TMP/install.out" 2> "$TMP/install.err"

for _ in {1..50}; do
  if [ -s "$FAKE_WATCHER_PWD_LOG" ] && [ -s "$FAKE_SLEEP_PID" ]; then
    break
  fi
  /bin/sleep 0.1
done

if [ ! -d "$HOME_DIR/.invoker" ]; then
  echo "[test] FAIL: expected install.sh to create $HOME_DIR/.invoker" >&2
  exit 1
fi

expected_crontab="@reboot cd $HOME_DIR && while true; do $BIN_DIR/invoker-watcher >> $HOME_DIR/.invoker/watcher.keepalive.log 2>&1; sleep 5; done"
if ! grep -Fxq "$expected_crontab" "$FAKE_CRONTAB_OUT"; then
  echo "[test] FAIL: crontab entry should cd to packaged WORK_DIR under HOME" >&2
  echo "[test] crontab contents:" >&2
  /bin/cat "$FAKE_CRONTAB_OUT" >&2
  exit 1
fi

if ! grep -Fxq "$HOME_DIR" "$FAKE_WATCHER_PWD_LOG"; then
  echo "[test] FAIL: immediate keepalive should run from packaged WORK_DIR under HOME" >&2
  echo "[test] watcher pwd log:" >&2
  /bin/cat "$FAKE_WATCHER_PWD_LOG" >&2
  exit 1
fi

if ! grep -q "watcher stdout" "$HOME_DIR/.invoker/watcher.keepalive.log"; then
  echo "[test] FAIL: expected immediate keepalive output to be redirected to watcher.keepalive.log" >&2
  exit 1
fi

echo "[test] PASS: watcher packaged cron fallback"
