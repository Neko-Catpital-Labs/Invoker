#!/usr/bin/env bash
# Demonstrates that `git push` can block indefinitely against a remote that
# accepts TCP but never completes the Git HTTP protocol — the same class of
# stall Invoker's post-agent path hit when `execGitSimple` had no timeout.
#
# Safe: uses a temp repo and kills the push with a wall-clock cap.
#
# Usage: bash scripts/repro/repro-git-push-hangs-no-timeout.sh
# Expect: exit 0; push must be stopped by the timeout wrapper (not exit quickly).
set -euo pipefail

TMP="$(mktemp -d)"
REPO="$TMP/repo"
PORT_FILE="$TMP/port"
NC_PID=""

cleanup() {
  if [[ -n "$NC_PID" ]] && kill -0 "$NC_PID" 2>/dev/null; then
    kill "$NC_PID" 2>/dev/null || true
    wait "$NC_PID" 2>/dev/null || true
  fi
  rm -rf "$TMP"
}
trap cleanup EXIT

mkdir -p "$REPO"
cd "$REPO"

git init >/dev/null
git config user.email "repro@local"
git config user.name "repro"
echo "x" >f
git add f
git commit -m init >/dev/null
git branch -M master 2>/dev/null || true
git checkout -b task-branch >/dev/null

# Free TCP port (no extra deps)
python3 - <<'PY' >"$PORT_FILE"
import socket
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
PORT="$(cat "$PORT_FILE")"

# TCP sink: accept one connection, read bytes forever, never reply → Git client can stall.
SINK_LOG="$TMP/sink.log"
python3 - "$PORT" >>"$SINK_LOG" 2>&1 <<'SINKPY' &
import socket
import sys

port = int(sys.argv[1])
s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", port))
s.listen(1)
print("listen", flush=True)
conn, _ = s.accept()
while True:
    conn.recv(65536)
SINKPY
NC_PID=$!

# Wait for bind + listen (sink prints "listen" after listen()).
for _ in $(seq 1 100); do
  if grep -q '^listen$' "$SINK_LOG" 2>/dev/null; then
    break
  fi
  sleep 0.05
done
if ! grep -q '^listen$' "$SINK_LOG" 2>/dev/null; then
  echo "ERROR: TCP sink did not start (see $SINK_LOG)." >&2
  cat "$SINK_LOG" >&2 || true
  exit 1
fi

# Smart-HTTP-ish URL; Git will try to talk HTTP to our sink.
git remote add origin "http://127.0.0.1:$PORT/dummy.git"

echo "==> Repro: git push against TCP sink (no valid Git response)."
echo "    Without a wall-clock cap, this can block until the process is killed."
echo "    Invoker bounds network git via INVOKER_GIT_NETWORK_TIMEOUT_MS (0 = unbounded legacy)."
echo ""

PUSH_OUT="$TMP/push.log"
PUSH_RC=0
set +e
if command -v timeout >/dev/null 2>&1; then
  timeout 5 git push -u origin task-branch >"$PUSH_OUT" 2>&1
  PUSH_RC=$?
else
  python3 - "$REPO" "$PUSH_OUT" <<'PY'
import subprocess
import sys
from pathlib import Path

repo, log_path = sys.argv[1], sys.argv[2]
try:
    r = subprocess.run(
        ["git", "push", "-u", "origin", "task-branch"],
        cwd=repo,
        timeout=5,
        capture_output=True,
        text=True,
    )
except subprocess.TimeoutExpired as e:
    Path(log_path).write_text((e.stdout or "") + (e.stderr or ""), encoding="utf-8")
    sys.exit(124)
Path(log_path).write_text((r.stdout or "") + (r.stderr or ""), encoding="utf-8")
sys.exit(2)
PY
  PUSH_RC=$?
fi
set -e

if [[ -s "$PUSH_OUT" ]]; then
  sed 's/^/    [git] /' "$PUSH_OUT"
fi

if [[ "$PUSH_RC" -eq 124 ]]; then
  echo ""
  echo "OK: push blocked until wall-clock cap (exit 124 with timeout(1), or Python timeout)."
  echo "    Without INVOKER_GIT_NETWORK_TIMEOUT_MS, Invoker's git spawn could wait indefinitely in the same class of stall."
  exit 0
fi

if [[ "$PUSH_RC" -eq 2 ]]; then
  echo "ERROR: git push returned before 5s — listener or remote URL may be wrong (expected a multi-second hang)." >&2
  exit 1
fi

echo "ERROR: expected capped stall (exit 124), got exit $PUSH_RC" >&2
echo "Install GNU coreutils \`timeout\` or ensure Python 3 is available." >&2
exit 1
