#!/usr/bin/env bash
set -euo pipefail

# Repro/proof script for merge-gate PR target routing.
#
# This script simulates the GitHubMergeGateProvider command sequence and logs:
# - upstream/origin remote URLs
# - resolved repo names
# - gh endpoint used for PR creation
#
# By default it proves the fixed behavior:
# - branch push goes to origin
# - PR create endpoint targets upstream repo
#
# Environment:
#   REPRO_KEEP_TMP=1     keep temp dir for inspection
#   TARGET_SOURCE=...    remote used to resolve PR target (upstream|origin)
#                        default: upstream
#   EXPECTED_TARGET=...  expected owner/repo for PR endpoint
#                        default: derived from TARGET_SOURCE

TMP_DIR="$(mktemp -d)"
if [[ "${REPRO_KEEP_TMP:-0}" != "1" ]]; then
  trap 'rm -rf "$TMP_DIR"' EXIT
fi

TARGET_SOURCE="${TARGET_SOURCE:-upstream}"
EXPECTED_TARGET="${EXPECTED_TARGET:-}"
LOG_FILE="$TMP_DIR/repro.log"
FAKE_GH_LOG="$TMP_DIR/gh.log"
FAKE_BIN="$TMP_DIR/bin"
mkdir -p "$FAKE_BIN" "$TMP_DIR/remotes/github.com/EdbertChan" "$TMP_DIR/remotes/github.com/Neko-Catpital-Labs"

ORIGIN_BARE="$TMP_DIR/remotes/github.com/EdbertChan/Invoker.git"
UPSTREAM_BARE="$TMP_DIR/remotes/github.com/Neko-Catpital-Labs/Invoker.git"
SEED_REPO="$TMP_DIR/seed"
WORK_REPO="$TMP_DIR/work"

git init --bare "$ORIGIN_BARE" >/dev/null
git init --bare "$UPSTREAM_BARE" >/dev/null

git clone "$UPSTREAM_BARE" "$SEED_REPO" >/dev/null
git -C "$SEED_REPO" config user.email "test@example.com"
git -C "$SEED_REPO" config user.name "test-user"
echo "seed" > "$SEED_REPO/README.md"
git -C "$SEED_REPO" add README.md
git -C "$SEED_REPO" commit -m "seed" >/dev/null
git -C "$SEED_REPO" push origin master >/dev/null
git -C "$SEED_REPO" remote add fork "$ORIGIN_BARE"
git -C "$SEED_REPO" push fork master >/dev/null

git clone "$ORIGIN_BARE" "$WORK_REPO" >/dev/null
git -C "$WORK_REPO" remote add upstream "$UPSTREAM_BARE"
git -C "$WORK_REPO" fetch upstream master >/dev/null 2>&1 || true
git -C "$WORK_REPO" config user.email "test@example.com"
git -C "$WORK_REPO" config user.name "test-user"

if [[ -z "$EXPECTED_TARGET" ]]; then
  TARGET_URL="$(git -C "$WORK_REPO" remote get-url "$TARGET_SOURCE")"
  EXPECTED_TARGET="$(printf '%s' "$TARGET_URL" | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$#\1#')"
fi

cat > "$FAKE_BIN/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
LOG_FILE="${FAKE_GH_LOG:?}"
EXPECTED_TARGET="${EXPECTED_TARGET:?}"

{
  echo "PWD=$(pwd)"
  echo "GH_CMD:$*"
} >> "$LOG_FILE"

if [[ "${1:-}" == "pr" && "${2:-}" == "list" ]]; then
  echo "[]"
  exit 0
fi

if [[ "${1:-}" == "api" && "${2:-}" == "repos/${EXPECTED_TARGET}/pulls" && "${3:-}" == "--method" && "${4:-}" == "POST" ]]; then
  echo "RESOLVED_ENDPOINT:repos/${EXPECTED_TARGET}/pulls" >> "$LOG_FILE"
  echo '{"html_url":"https://github.com/'"$EXPECTED_TARGET"'/pull/999","number":999}'
  exit 0
fi

echo "unexpected gh invocation: $*" >&2
exit 1
EOF
chmod +x "$FAKE_BIN/gh"

{
  echo "== repro start =="
  echo "tmp_dir=$TMP_DIR"
  echo "work_repo=$WORK_REPO"
  echo "origin_remote=$(git -C "$WORK_REPO" remote get-url origin)"
  echo "upstream_remote=$(git -C "$WORK_REPO" remote get-url upstream)"
  echo "target_source=$TARGET_SOURCE"
  echo "expected_target=$EXPECTED_TARGET"
} | tee "$LOG_FILE"

FEATURE_BRANCH="repro/merge-gate-target"
git -C "$WORK_REPO" switch -c "$FEATURE_BRANCH" >/dev/null
echo "repro-change" >> "$WORK_REPO/README.md"
git -C "$WORK_REPO" add README.md
git -C "$WORK_REPO" commit -m "repro change" >/dev/null

(
  cd "$WORK_REPO"
  TARGET_URL="$(git remote get-url "$TARGET_SOURCE")"
  TARGET_REPO="$(printf '%s' "$TARGET_URL" | sed -E 's#.*github\.com[:/]([^/]+/[^/.]+)(\.git)?/?$#\1#')"
  echo "TARGET_REPO=$TARGET_REPO" >> "$FAKE_GH_LOG"

  # branch publication remains origin
  PATH="$FAKE_BIN:$PATH" FAKE_GH_LOG="$FAKE_GH_LOG" EXPECTED_TARGET="$EXPECTED_TARGET" git push --force -u origin "$FEATURE_BRANCH" >/dev/null
  PATH="$FAKE_BIN:$PATH" FAKE_GH_LOG="$FAKE_GH_LOG" EXPECTED_TARGET="$EXPECTED_TARGET" gh pr list --repo "$TARGET_REPO" --head "$FEATURE_BRANCH" --base master --state open --json url,number --limit 1 >/dev/null
  PATH="$FAKE_BIN:$PATH" FAKE_GH_LOG="$FAKE_GH_LOG" EXPECTED_TARGET="$EXPECTED_TARGET" gh api "repos/$TARGET_REPO/pulls" --method POST -f base=master -f head="$FEATURE_BRANCH" -f title="repro" -f body=""
) || {
  echo "FAIL: repro command sequence failed" | tee -a "$LOG_FILE"
  exit 1
}

echo "== gh log ==" | tee -a "$LOG_FILE"
sed -n '1,200p' "$FAKE_GH_LOG" | tee -a "$LOG_FILE"
echo "== repro end ==" | tee -a "$LOG_FILE"

if ! rg -q "RESOLVED_ENDPOINT:repos/${EXPECTED_TARGET}/pulls" "$FAKE_GH_LOG"; then
  echo "FAIL: expected PR endpoint repos/${EXPECTED_TARGET}/pulls" >&2
  exit 1
fi

echo "PASS: merge-gate repro confirms endpoint repos/${EXPECTED_TARGET}/pulls and branch push to origin"
echo "Repro log written to: $LOG_FILE"
if [[ "${REPRO_KEEP_TMP:-0}" == "1" ]]; then
  echo "Temporary directory preserved: $TMP_DIR"
fi
