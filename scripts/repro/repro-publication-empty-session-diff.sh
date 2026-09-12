#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CREATE_PR="$ROOT/scripts/create-pr.mjs"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-publication-integrity.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $1" >&2
  if [ -n "${2:-}" ]; then
    echo "----- detail -----" >&2
    printf '%s\n' "$2" >&2
  fi
  exit 1
}

export HOME="$TMP/home"
mkdir -p "$HOME" "$TMP/bin"
export PATH="$TMP/bin:$PATH"

cat > "$TMP/bin/gh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

if [ "${1:-}" = "repo" ] && [ "${2:-}" = "view" ]; then
  printf '%s' 'owner/repo'
  exit 0
fi

if [ "${1:-}" = "api" ]; then
  route="${2:-}"
  case "$route" in
    repos/owner/repo/pulls)
      if [ "${3:-}" = "--method" ] && [ "${4:-}" = "POST" ]; then
        cat >/dev/null
        printf '{"html_url":"https://example.test/pull/123","number":123}'
        exit 0
      fi
      ;;
    repos/owner/repo/pulls\?*)
      printf '[]'
      exit 0
      ;;
    repos/owner/repo/issues/*/comments\?*)
      printf '[]'
      exit 0
      ;;
    repos/owner/repo/issues/*/comments)
      cat >/dev/null
      printf '{"id":123}'
      exit 0
      ;;
  esac
fi

printf 'unexpected gh invocation: %s\n' "$*" >&2
exit 2
EOF
chmod +x "$TMP/bin/gh"

VALID_BODY="$TMP/pr-body.md"
cat > "$VALID_BODY" <<'EOF'
## Summary

This branch publishes a repair.

## Review Claim

Keep repair publication tied to the fixing session.

## Review Lane

- policy

## Review Unit

- tooling-policy

## Safety Invariant

Only publication integrity behavior changes.

## Slice Rationale

One repair-publication guard.

## Non-goals

- Do not change runtime behavior.

## Test Plan

<details>
<summary>Test Plan</summary>

- [ ] `bash scripts/repro/repro-publication-empty-session-diff.sh`

</details>

## Revert Plan

<details>
<summary>Revert Plan</summary>

- Safe to revert? Yes
- Revert command: `git revert <sha>`
- Post-revert steps: None
- Data migration? No

</details>
EOF

ORIGIN="$TMP/origin.git"
WORK="$TMP/work"

git init --bare -b master "$ORIGIN" >/dev/null
git clone "$ORIGIN" "$WORK" >/dev/null
git -C "$WORK" config user.email repro@example.test
git -C "$WORK" config user.name 'Repro Bot'
printf 'seed\n' > "$WORK/README.md"
git -C "$WORK" add README.md
git -C "$WORK" commit -m 'seed' >/dev/null
git -C "$WORK" push origin master >/dev/null

publish() {
  local branch="$1"
  local chain="$2"
  local commit="$3"
  local title="${4:-test title}"
  (
    cd "$WORK"
    git switch "$branch" >/dev/null
    env \
      INVOKER_REPAIR_PUBLICATION=1 \
      INVOKER_REPAIR_TASK_CHAIN_ID="$chain" \
      INVOKER_REPAIR_SESSION_COMMIT="$commit" \
      node "$CREATE_PR" --title "$title" --base master --body-file "$VALID_BODY"
  ) 2>&1
}

make_session_commit() {
  local branch="$1"
  local file="$2"
  git -C "$WORK" switch -C "$branch" origin/master >/dev/null
  printf 'fix session for %s\n' "$branch" > "$WORK/$file"
  git -C "$WORK" add "$file"
  git -C "$WORK" commit -m "fix session $branch" >/dev/null
  git -C "$WORK" rev-parse HEAD
}

make_publication_branch() {
  local branch="$1"
  local start="$2"
  local file="$3"
  git -C "$WORK" switch -C "$branch" "$start" >/dev/null
  printf 'published change for %s\n' "$branch" > "$WORK/$file"
  git -C "$WORK" add "$file"
  git -C "$WORK" commit -m "publish $branch" >/dev/null
}

# (a) Backtest PR 8784 shape: the repair publication has a nonempty diff, but
# there is no recorded fix-session commit to prove the fixing agent authored it.
make_publication_branch "plan/pr-8784-quality-typescript-types" "origin/master" "pr8784-publication-authored.txt"
if out="$(publish "plan/pr-8784-quality-typescript-types" "wf-20260812-pr-8784" "" || true)"; then
  if ! grep -q 'repair-publication-missing-session-commit' <<<"$out"; then
    fail 'case (a) should name missing session commit' "$out"
  fi
else
  fail 'case (a) command wrapper failed unexpectedly'
fi
echo "PASS: case (a) PR 8784 missing session commit is refused"

# (b) The task recorded a commit, but the branch being published does not contain it.
RECORDED_B="$(make_session_commit session/case-b case-b-owned.txt)"
make_publication_branch "plan/case-b-unowned-head" "origin/master" "case-b-publication-authored.txt"
if out="$(publish "plan/case-b-unowned-head" "wf-case-b" "$RECORDED_B" || true)"; then
  if ! grep -q 'repair-publication-unowned-diff' <<<"$out"; then
    fail 'case (b) should name unowned diff' "$out"
  fi
else
  fail 'case (b) command wrapper failed unexpectedly'
fi
echo "PASS: case (b) published head missing recorded commit is refused"

# (c) The published head contains the recorded fixing-session commit.
RECORDED_C="$(make_session_commit session/case-c case-c-owned.txt)"
make_publication_branch "plan/case-c-owned-head" "$RECORDED_C" "case-c-followup.txt"
if ! out="$(publish "plan/case-c-owned-head" "wf-case-c" "$RECORDED_C")"; then
  fail 'case (c) should publish when head contains recorded commit' "$out"
fi
if ! grep -q 'https://example.test/pull/123' <<<"$out"; then
  fail 'case (c) should print created PR URL' "$out"
fi
echo "PASS: case (c) recorded commit ancestor is allowed"

# (d) Backtest duplicate 8791/8805 shape: one task chain first publishes through
# the plan lineage, then tries to publish the same chain through a stack lineage.
RECORDED_D="$(make_session_commit session/case-d case-d-owned.txt)"
make_publication_branch "plan/pr-8791-quality-typescript-types" "$RECORDED_D" "case-d-plan.txt"
if ! out="$(publish "plan/pr-8791-quality-typescript-types" "wf-20260812-8791-8805" "$RECORDED_D")"; then
  fail 'case (d) first lineage should publish' "$out"
fi
make_publication_branch "stack/repro/pr/quality-typescript-types" "$RECORDED_D" "case-d-stack.txt"
if out="$(publish "stack/repro/pr/quality-typescript-types" "wf-20260812-8791-8805" "$RECORDED_D" "[Quality Types](1) repair types" || true)"; then
  if ! grep -q 'repair-publication-duplicate-lineage' <<<"$out"; then
    fail 'case (d) should name duplicate lineage' "$out"
  fi
else
  fail 'case (d) command wrapper failed unexpectedly'
fi
echo "PASS: case (d) 8791/8805 second branch lineage is refused"
