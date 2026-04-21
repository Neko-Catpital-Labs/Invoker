#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-local-wt-delete.XXXXXX")"
SHARED_STORE="$TMP_DIR/shared-store"
HOME_A="$TMP_DIR/home-a"
HOME_B="$TMP_DIR/home-b"
INVOKER_A="$HOME_A/invoker-a"
INVOKER_B="$HOME_B/invoker-b"
REPO_DIR="$TMP_DIR/repo"
PLAN_PATH="$TMP_DIR/plan.yaml"
WRAP_DIR="$TMP_DIR/fake-bin"
A_STDOUT="$TMP_DIR/process-a.stdout.log"
A_STDERR="$TMP_DIR/process-a.stderr.log"
B_STDOUT="$TMP_DIR/process-b.stdout.log"
B_STDERR="$TMP_DIR/process-b.stderr.log"
GIT_LOG="$TMP_DIR/git-wrapper.log"
PNPM_LOG="$TMP_DIR/pnpm-wrapper.log"
MARKER_DIR="$TMP_DIR/markers"
SEED_STDOUT="$TMP_DIR/seed.stdout.log"
SEED_STDERR="$TMP_DIR/seed.stderr.log"
POLL_TIMEOUT_SECONDS="${POLL_TIMEOUT_SECONDS:-30}"
PNPM_SLEEP_SECONDS="${PNPM_SLEEP_SECONDS:-15}"

cleanup() {
  if [[ -n "${A_PID:-}" ]]; then
    kill "$A_PID" >/dev/null 2>&1 || true
  fi
  if [[ -n "${B_PID:-}" ]]; then
    kill "$B_PID" >/dev/null 2>&1 || true
  fi
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

poll_for_file() {
  local target="$1"
  local seconds="${2:-$POLL_TIMEOUT_SECONDS}"
  local ticks=$(( seconds * 10 ))
  for ((i=0; i<ticks; i++)); do
    if [[ -e "$target" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

poll_for_absence() {
  local target="$1"
  local seconds="${2:-$POLL_TIMEOUT_SECONDS}"
  local ticks=$(( seconds * 10 ))
  for ((i=0; i<ticks; i++)); do
    if [[ ! -e "$target" ]]; then
      return 0
    fi
    sleep 0.1
  done
  return 1
}

mkdir -p "$SHARED_STORE/repos" "$SHARED_STORE/worktrees" "$MARKER_DIR" "$WRAP_DIR" "$INVOKER_A" "$INVOKER_B" "$REPO_DIR"
mkdir -p "$HOME_A" "$HOME_B"
ln -s "$SHARED_STORE/repos" "$INVOKER_A/repos"
ln -s "$SHARED_STORE/worktrees" "$INVOKER_A/worktrees"
ln -s "$SHARED_STORE/repos" "$INVOKER_B/repos"
ln -s "$SHARED_STORE/worktrees" "$INVOKER_B/worktrees"

pushd "$ROOT_DIR" >/dev/null

if [[ ! -f packages/app/dist/main.js ]]; then
  pnpm --filter @invoker/app build >/dev/null
fi

ELECTRON_BIN="$ROOT_DIR/packages/app/node_modules/.bin/electron"
MAIN_JS="$ROOT_DIR/packages/app/dist/main.js"
GIT_REAL="$(command -v git)"
PNPM_REAL="$(command -v pnpm)"

cat > "$WRAP_DIR/git" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s|pid=%s|cwd=%s|git %s\n' "\${REPRO_ROLE:-unknown}" "\$\$" "\$PWD" "\$*" >> "$GIT_LOG"
exec "$GIT_REAL" "\$@"
EOF
chmod +x "$WRAP_DIR/git"

cat > "$WRAP_DIR/pnpm" <<EOF
#!/usr/bin/env bash
set -euo pipefail
printf '%s|pid=%s|cwd=%s|pnpm %s\n' "\${REPRO_ROLE:-unknown}" "\$\$" "\$PWD" "\$*" >> "$PNPM_LOG"
if [[ "\${REPRO_ROLE:-}" == "A" ]]; then
  touch "$MARKER_DIR/a-pnpm-started"
  sleep "$PNPM_SLEEP_SECONDS"
fi
exec node -e "process.cwd(); process.exit(0)"
EOF
chmod +x "$WRAP_DIR/pnpm"

cat > "$REPO_DIR/package.json" <<'EOF'
{
  "name": "invoker-repro-local-worktree-delete",
  "private": true,
  "version": "1.0.0",
  "packageManager": "pnpm@10.11.0"
}
EOF

cat > "$REPO_DIR/pnpm-lock.yaml" <<'EOF'
lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:
  .: {}
EOF

cat > "$PLAN_PATH" <<EOF
name: Two Process Local Worktree Delete Repro
repoUrl: $REPO_DIR
tasks:
  - id: slow-provision
    description: Slow provisioning repro task
    command: echo repro-task
EOF

"$GIT_REAL" -C "$REPO_DIR" init -b master >/dev/null
"$GIT_REAL" -C "$REPO_DIR" add package.json pnpm-lock.yaml
"$GIT_REAL" -C "$REPO_DIR" -c user.name='Invoker Repro' -c user.email='repro@example.com' commit -m 'seed repo' >/dev/null

cat > "$INVOKER_A/config.json" <<'EOF'
{
  "maxConcurrency": 1
}
EOF

cat > "$INVOKER_B/config.json" <<'EOF'
{
  "maxConcurrency": 1
}
EOF

HOME="$HOME_A" \
INVOKER_DB_DIR="$INVOKER_A" \
INVOKER_HEADLESS_STANDALONE=1 \
PATH="$WRAP_DIR:$PATH" \
"$ELECTRON_BIN" "$MAIN_JS" --headless --no-track run "$PLAN_PATH" \
  >"$SEED_STDOUT" 2>"$SEED_STDERR"

WORKFLOW_ID="$(sed -n 's/^Workflow ID: //p' "$SEED_STDOUT" | head -n1 || true)"
if [[ -z "$WORKFLOW_ID" ]]; then
  echo "repro: seed phase failed to report a workflow id" >&2
  cat "$SEED_STDOUT" >&2 || true
  cat "$SEED_STDERR" >&2 || true
  exit 1
fi

TASK_ID="$WORKFLOW_ID/slow-provision"

HOME="$HOME_A" \
INVOKER_DB_DIR="$INVOKER_A" \
INVOKER_HEADLESS_STANDALONE=1 \
REPRO_ROLE=A \
PATH="$WRAP_DIR:$PATH" \
"$ELECTRON_BIN" "$MAIN_JS" --headless --no-track resume "$WORKFLOW_ID" \
  >"$A_STDOUT" 2>"$A_STDERR" &
A_PID=$!

if ! poll_for_file "$MARKER_DIR/a-pnpm-started" "$POLL_TIMEOUT_SECONDS"; then
  echo "repro: process A never entered provisioning" >&2
  cat "$A_STDOUT" >&2 || true
  cat "$A_STDERR" >&2 || true
  exit 1
fi

python3 - "$INVOKER_A/invoker.db" "$INVOKER_B/invoker.db" <<'PY'
import sqlite3, sys
src, dst = sys.argv[1], sys.argv[2]
src_conn = sqlite3.connect(src, uri=False)
dst_conn = sqlite3.connect(dst, uri=False)
src_conn.backup(dst_conn)
dst_conn.close()
src_conn.close()
PY

WORKTREE_PATH=""
for _ in {1..200}; do
  CANDIDATE="$(find "$SHARED_STORE/worktrees" -mindepth 2 -maxdepth 2 -type d | head -n1 || true)"
  if [[ -n "$CANDIDATE" ]]; then
    WORKTREE_PATH="$CANDIDATE"
    break
  fi
  sleep 0.1
done

if [[ -z "$WORKTREE_PATH" ]]; then
  echo "repro: failed to discover shared worktree path" >&2
  cat "$A_STDOUT" >&2 || true
  cat "$A_STDERR" >&2 || true
  exit 1
fi

WORKTREE_PATH_CANONICAL="$(python3 - "$WORKTREE_PATH" <<'PY'
import os, sys
print(os.path.realpath(sys.argv[1]))
PY
)"

HOME="$HOME_B" \
INVOKER_DB_DIR="$INVOKER_B" \
INVOKER_HEADLESS_STANDALONE=1 \
REPRO_ROLE=B \
PATH="$WRAP_DIR:$PATH" \
"$ELECTRON_BIN" "$MAIN_JS" --headless --no-track resume "$WORKFLOW_ID" \
  >"$B_STDOUT" 2>"$B_STDERR" &
B_PID=$!

WORKTREE_DISAPPEARED="no"
if poll_for_absence "$WORKTREE_PATH_CANONICAL" "$POLL_TIMEOUT_SECONDS"; then
  WORKTREE_DISAPPEARED="yes"
fi

wait "$A_PID" || true
wait "$B_PID" || true

REMOVE_HIT="no"
if grep -Fq "git worktree remove --force $WORKTREE_PATH_CANONICAL" "$GIT_LOG" || grep -Fq "git worktree remove --force $WORKTREE_PATH" "$GIT_LOG"; then
  REMOVE_HIT="yes"
fi

UV_CWD_HIT="no"
if grep -Eq 'uv_cwd|ENOENT: no such file or directory, uv_cwd|Worktree provisioning failed' "$A_STDOUT" "$A_STDERR"; then
  UV_CWD_HIT="yes"
fi

A_PNPM_CWD="$(sed -n 's/^A|pid=[^|]*|cwd=\([^|]*\)|pnpm .*/\1/p' "$PNPM_LOG" | head -n1 || true)"
B_PNPM_CWD="$(sed -n 's/^B|pid=[^|]*|cwd=\([^|]*\)|pnpm .*/\1/p' "$PNPM_LOG" | head -n1 || true)"
SAME_PATH="unknown"
if [[ -n "$A_PNPM_CWD" && -n "$B_PNPM_CWD" ]]; then
  if [[ "$A_PNPM_CWD" == "$B_PNPM_CWD" ]]; then
    SAME_PATH="yes"
  else
    SAME_PATH="no"
  fi
fi

echo "==> Two-process local worktree delete repro"
echo "workflow: $WORKFLOW_ID"
echo "task: $TASK_ID"
echo "shared worktree path: $WORKTREE_PATH"
echo "canonical worktree path: $WORKTREE_PATH_CANONICAL"
echo "git wrapper log: $GIT_LOG"
echo "pnpm wrapper log: $PNPM_LOG"
echo "worktree_disappeared=$WORKTREE_DISAPPEARED"
echo "git_worktree_remove_hit=$REMOVE_HIT"
echo "a_uv_cwd_hit=$UV_CWD_HIT"
echo "a_pnpm_cwd=${A_PNPM_CWD:-<none>}"
echo "b_pnpm_cwd=${B_PNPM_CWD:-<none>}"
echo "same_worktree_path=$SAME_PATH"
echo

if [[ "$REMOVE_HIT" == "yes" && "$WORKTREE_DISAPPEARED" == "yes" && "$UV_CWD_HIT" == "yes" && "$SAME_PATH" == "yes" ]]; then
  echo "RESULT: confirmed"
  echo "A second real Invoker process removed the active local worktree path while process A was provisioning."
  exit 0
fi

echo "RESULT: falsified"
echo "Under these real Invoker commands, the second process did not prove a self-delete of the active local worktree."
echo
echo "--- process A stdout ---"
cat "$A_STDOUT" || true
echo "--- process A stderr ---"
cat "$A_STDERR" || true
echo "--- process B stdout ---"
cat "$B_STDOUT" || true
echo "--- process B stderr ---"
cat "$B_STDERR" || true
echo "--- git wrapper log ---"
cat "$GIT_LOG" || true
echo "--- pnpm wrapper log ---"
cat "$PNPM_LOG" || true
