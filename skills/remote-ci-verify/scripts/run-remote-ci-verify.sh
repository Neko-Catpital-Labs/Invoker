#!/usr/bin/env bash
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT"

BRANCH="${CI_VERIFY_BRANCH:-$(git rev-parse --abbrev-ref HEAD)}"
REMOTE_NAME="${CI_VERIFY_REMOTE:-origin}"
PUSH_BRANCH="${CI_VERIFY_PUSH:-1}"
FORCE_PUSH="${CI_VERIFY_FORCE_PUSH:-0}"
CONFIG_PATH="${INVOKER_REPO_CONFIG_PATH:-$HOME/.invoker/config.json}"
DB_PATH="${CI_VERIFY_DB_PATH:-${INVOKER_DB_DIR:-$HOME/.invoker}/invoker.db}"
TARGET_ALLOWLIST="${CI_VERIFY_TARGETS:-}"
SSH_TIMEOUT="${CI_VERIFY_CONNECT_TIMEOUT:-8}"

REMOTE_BASE_DIR="${CI_VERIFY_REMOTE_BASE_DIR:-}"
REMOTE_INSTALL="${CI_VERIFY_REMOTE_INSTALL:-1}"
REMOTE_BUILD_UI="${CI_VERIFY_REMOTE_BUILD_UI:-1}"
REMOTE_INSTALL_PLAYWRIGHT_DEPS="${CI_VERIFY_REMOTE_INSTALL_PLAYWRIGHT_DEPS:-1}"
REMOTE_KEEP_WORKTREE="${CI_VERIFY_KEEP_REMOTE_WORKTREE:-0}"
REMOTE_TEST_CMD="${CI_VERIFY_REMOTE_TEST_COMMAND:-pnpm run test:all}"

if [[ "$BRANCH" == "HEAD" ]]; then
  echo "ERROR: Detached HEAD detected. Set CI_VERIFY_BRANCH=<branch> explicitly." >&2
  exit 1
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "ERROR: python3 is required for reading Invoker config JSON." >&2
  exit 1
fi

if ! command -v ssh >/dev/null 2>&1; then
  echo "ERROR: ssh is required." >&2
  exit 1
fi

REPO_URL="$(git remote get-url "$REMOTE_NAME")"
REPO_SLUG="$(basename -s .git "$REPO_URL" | tr -c 'A-Za-z0-9._-' '-')"

if [[ "$PUSH_BRANCH" == "1" ]]; then
  echo "==> Pushing branch '$BRANCH' to $REMOTE_NAME"
  if [[ "$FORCE_PUSH" == "1" ]]; then
    git push --force-with-lease -u "$REMOTE_NAME" "$BRANCH"
  else
    git push -u "$REMOTE_NAME" "$BRANCH"
  fi
fi

if [[ ! -f "$CONFIG_PATH" ]]; then
  echo "ERROR: Invoker config not found at $CONFIG_PATH" >&2
  exit 1
fi

mapfile -t TARGETS < <(python3 - "$CONFIG_PATH" <<'PY'
import json
import sys

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    cfg = json.load(f)

for tid, t in sorted((cfg.get('remoteTargets') or {}).items()):
    host = str(t.get('host', '')).strip()
    user = str(t.get('user', '')).strip()
    key = str(t.get('sshKeyPath', '')).strip()
    if not (host and user and key):
        continue
    port = int(t.get('port') or 22)
    print(f"{tid}|{user}|{host}|{port}|{key}")
PY
)

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  echo "ERROR: No valid remoteTargets found in $CONFIG_PATH" >&2
  exit 1
fi

declare -A ALLOW=()
if [[ -n "$TARGET_ALLOWLIST" ]]; then
  IFS=',' read -r -a raw_allow <<< "$TARGET_ALLOWLIST"
  for t in "${raw_allow[@]}"; do
    trimmed="$(echo "$t" | xargs)"
    [[ -n "$trimmed" ]] && ALLOW["$trimmed"]=1
  done
fi

declare -A BUSY=()
if command -v sqlite3 >/dev/null 2>&1 && [[ -f "$DB_PATH" ]]; then
  while IFS= read -r tid; do
    [[ -n "$tid" ]] && BUSY["$tid"]=1
  done < <(
    sqlite3 "$DB_PATH" "
      SELECT DISTINCT remote_target_id
      FROM tasks
      WHERE remote_target_id IS NOT NULL
        AND remote_target_id != ''
        AND status IN ('running','awaiting_approval','review_ready','needs_input','fixing_with_ai');
    " 2>/dev/null || true
  )
fi

SELECTED=""
SELECTED_ID=""
SELECTED_USER=""
SELECTED_HOST=""
SELECTED_PORT=""
SELECTED_KEY=""

for row in "${TARGETS[@]}"; do
  IFS='|' read -r tid user host port key <<< "$row"

  if [[ ${#ALLOW[@]} -gt 0 && -z "${ALLOW[$tid]:-}" ]]; then
    continue
  fi

  if [[ -n "${BUSY[$tid]:-}" ]]; then
    echo "Skipping busy target from Invoker DB: $tid"
    continue
  fi

  if [[ ! -r "$key" ]]; then
    echo "Skipping target '$tid': sshKeyPath not readable ($key)"
    continue
  fi

  if ssh -i "$key" -p "$port" \
       -o BatchMode=yes \
       -o StrictHostKeyChecking=accept-new \
       -o ConnectTimeout="$SSH_TIMEOUT" \
       "$user@$host" true >/dev/null 2>&1; then
    SELECTED="$row"
    SELECTED_ID="$tid"
    SELECTED_USER="$user"
    SELECTED_HOST="$host"
    SELECTED_PORT="$port"
    SELECTED_KEY="$key"
    break
  fi

  echo "Target not reachable: $tid ($user@$host:$port)"
done

if [[ -z "$SELECTED" ]]; then
  echo "ERROR: No available SSH target found." >&2
  exit 1
fi

echo "==> Selected target: $SELECTED_ID ($SELECTED_USER@$SELECTED_HOST:$SELECTED_PORT)"

echo "==> Running remote CI-equivalent flow"
ssh -tt \
  -i "$SELECTED_KEY" \
  -p "$SELECTED_PORT" \
  -o BatchMode=yes \
  -o StrictHostKeyChecking=accept-new \
  "$SELECTED_USER@$SELECTED_HOST" \
  BRANCH="$BRANCH" \
  REMOTE_NAME="$REMOTE_NAME" \
  REPO_URL="$REPO_URL" \
  REPO_SLUG="$REPO_SLUG" \
  TARGET_ID="$SELECTED_ID" \
  CI_VERIFY_REMOTE_BASE_DIR="$REMOTE_BASE_DIR" \
  CI_VERIFY_REMOTE_INSTALL="$REMOTE_INSTALL" \
  CI_VERIFY_REMOTE_BUILD_UI="$REMOTE_BUILD_UI" \
  CI_VERIFY_REMOTE_INSTALL_PLAYWRIGHT_DEPS="$REMOTE_INSTALL_PLAYWRIGHT_DEPS" \
  CI_VERIFY_KEEP_REMOTE_WORKTREE="$REMOTE_KEEP_WORKTREE" \
  CI_VERIFY_REMOTE_TEST_COMMAND="$REMOTE_TEST_CMD" \
  'bash -se' <<'REMOTE_EOF'
set -euo pipefail

: "${BRANCH:?}"
: "${REMOTE_NAME:?}"
: "${REPO_URL:?}"
: "${REPO_SLUG:?}"
: "${TARGET_ID:?}"

BASE_DIR="${CI_VERIFY_REMOTE_BASE_DIR:-$HOME/.invoker/ci-verify}"
CLONE_DIR="$BASE_DIR/repos/$REPO_SLUG"
WT_ROOT="$BASE_DIR/worktrees/$REPO_SLUG"
LOCK_ROOT="$BASE_DIR/locks"
BRANCH_SAFE="$(echo "$BRANCH" | tr '/:@ ' '----' | tr -cd 'A-Za-z0-9._-')"
RUN_ID="$(date +%Y%m%d-%H%M%S)-$$"
WT_DIR="$WT_ROOT/${BRANCH_SAFE}-${RUN_ID}"
LOCK_DIR="$LOCK_ROOT/${TARGET_ID}.lock"

mkdir -p "$BASE_DIR/repos" "$WT_ROOT" "$LOCK_ROOT"
if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "ERROR: Remote target lock exists ($LOCK_DIR). Another verify run is active." >&2
  exit 1
fi

cleanup() {
  local ec=$?
  if [[ "${CI_VERIFY_KEEP_REMOTE_WORKTREE}" != "1" ]]; then
    git -C "$CLONE_DIR" worktree remove --force "$WT_DIR" >/dev/null 2>&1 || true
    git -C "$CLONE_DIR" worktree prune >/dev/null 2>&1 || true
  fi
  rm -rf "$LOCK_DIR" >/dev/null 2>&1 || true
  exit "$ec"
}
trap cleanup EXIT

if [[ ! -d "$CLONE_DIR/.git" ]]; then
  echo "==> [remote] Cloning repo into $CLONE_DIR"
  git clone "$REPO_URL" "$CLONE_DIR"
else
  echo "==> [remote] Reusing clone $CLONE_DIR"
fi

git -C "$CLONE_DIR" remote set-url "$REMOTE_NAME" "$REPO_URL" || true
git -C "$CLONE_DIR" fetch "$REMOTE_NAME" "$BRANCH" --prune

if git -C "$CLONE_DIR" worktree list --porcelain | grep -q "^worktree $WT_DIR$"; then
  git -C "$CLONE_DIR" worktree remove --force "$WT_DIR" || true
fi

echo "==> [remote] Creating worktree $WT_DIR from $REMOTE_NAME/$BRANCH"
git -C "$CLONE_DIR" worktree add --force "$WT_DIR" "$REMOTE_NAME/$BRANCH"

cd "$WT_DIR"

if [[ "${CI_VERIFY_REMOTE_INSTALL}" == "1" ]]; then
  echo "==> [remote] pnpm install --frozen-lockfile"
  pnpm install --frozen-lockfile
fi

if [[ "${CI_VERIFY_REMOTE_BUILD_UI}" == "1" ]]; then
  echo "==> [remote] pnpm --filter @invoker/ui build"
  pnpm --filter @invoker/ui build
fi

if [[ "${CI_VERIFY_REMOTE_INSTALL_PLAYWRIGHT_DEPS}" == "1" ]]; then
  echo "==> [remote] pnpm --filter @invoker/app exec playwright install --with-deps"
  pnpm --filter @invoker/app exec playwright install --with-deps
fi

export CI=true

echo "==> [remote] ${CI_VERIFY_REMOTE_TEST_COMMAND}"
bash -lc "$CI_VERIFY_REMOTE_TEST_COMMAND"

echo "==> [remote] CI verify complete"
REMOTE_EOF

echo "==> Completed on target: $SELECTED_ID"
