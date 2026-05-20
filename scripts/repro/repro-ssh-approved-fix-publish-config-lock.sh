#!/usr/bin/env bash
set -euo pipefail

EXPECTATION=""
KEEP_ARTIFACTS=0

usage() {
  cat <<'EOF'
Usage:
  bash scripts/repro/repro-ssh-approved-fix-publish-config-lock.sh --expect issue|fixed [--keep-artifacts]

What it proves:
  The SSH approved-fix publish path still mutates a persistent git remote
  named invoker-branches. If another process holds .git/config.lock in the
  shared remote clone/worktree, git remote add/set-url fails with the same
  config.lock class seen in failed tasks.

This script is self-contained. It creates a temporary git repo and runs the
same remote add/set-url shape used by buildRecordAndPushScript.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect)
      EXPECTATION="${2:-}"
      shift 2
      ;;
    --keep-artifacts)
      KEEP_ARTIFACTS=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ "$EXPECTATION" != "issue" && "$EXPECTATION" != "fixed" ]]; then
  echo "--expect must be issue or fixed" >&2
  usage >&2
  exit 2
fi

command -v git >/dev/null 2>&1 || { echo "git is required" >&2; exit 2; }

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-repro-publish-config-lock.XXXXXX")"
cleanup() {
  if [[ "$KEEP_ARTIFACTS" != "1" ]]; then
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

source_repo="$TMP_DIR/source"
remote_repo="$TMP_DIR/remote.git"
worktree="$TMP_DIR/worktree"

git init -b master "$source_repo" >/dev/null
git -C "$source_repo" config user.name "Invoker Repro"
git -C "$source_repo" config user.email "invoker-repro@example.invalid"
printf 'seed\n' >"$source_repo/README.md"
git -C "$source_repo" add README.md
git -C "$source_repo" commit -m seed >/dev/null
git init --bare "$remote_repo" >/dev/null
git -C "$source_repo" remote add origin "$remote_repo"
git -C "$source_repo" push -u origin master >/dev/null 2>&1
git clone "$remote_repo" "$worktree" >/dev/null 2>&1

touch "$worktree/.git/config.lock"

set +e
publish_output="$(
  (
    cd "$worktree" && {
    if git remote get-url invoker-branches >/dev/null 2>&1; then
      git remote set-url invoker-branches "$remote_repo"
    else
      git remote add invoker-branches "$remote_repo"
    fi
    }
  ) 2>&1
)"
publish_status=$?
set -e

if [[ "$publish_status" -ne 0 ]] && grep -Eqi 'config\.lock|could not lock config file|failed to write new configuration file' <<<"$publish_output"; then
  OBSERVED="issue"
else
  OBSERVED="fixed"
fi

echo "worktree=$worktree"
echo "publish_status=$publish_status"
echo "publish_output=${publish_output//$'\n'/ | }"
echo "observed=$OBSERVED"
echo "expected=$EXPECTATION"

if [[ "$OBSERVED" != "$EXPECTATION" ]]; then
  exit 1
fi

echo "==> repro matched expectation"
