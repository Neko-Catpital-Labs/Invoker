#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/scrub-handoff-artifacts-test.XXXXXX")"
trap 'rm -rf "$TEST_ROOT"' EXIT

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

assert_equal() {
  local expected="$1"
  local actual="$2"
  local message="$3"
  [[ "$actual" == "$expected" ]] || fail "$message: expected [$expected], got [$actual]"
}

snapshot() {
  {
    printf 'HEAD=%s\n' "$(git rev-parse HEAD)"
    git status --porcelain=v1 --untracked-files=all
    for path in tracked.txt staged.txt unstaged.txt unrelated-untracked.txt plans/invoker-handoff.md plans/invoker-handoff.yaml; do
      if [[ -e "$path" || -L "$path" ]]; then
        printf 'FILE=%s\n' "$path"
        sed -n '1,20p' "$path"
      else
        printf 'MISSING=%s\n' "$path"
      fi
    done
  }
}

mkdir -p "$TEST_ROOT/repo/scripts" "$TEST_ROOT/repo/plans"
cp "$ROOT/scripts/scrub-handoff-artifacts.sh" "$TEST_ROOT/repo/scripts/scrub-handoff-artifacts.sh"
cd "$TEST_ROOT/repo"
git init -q
git config user.name test
git config user.email test@example.com
printf 'tracked-clean\n' > tracked.txt
printf 'staged-base\n' > staged.txt
printf 'unstaged-base\n' > unstaged.txt
printf 'tracked-handoff\n' > plans/invoker-handoff.md
git add .
git commit -qm baseline

printf 'staged-change\n' > staged.txt
git add staged.txt
printf 'unstaged-change\n' > unstaged.txt
printf 'untracked-change\n' > unrelated-untracked.txt
printf 'untracked-handoff\n' > plans/invoker-handoff.yaml

before="$(snapshot)"
set +e
bash scripts/scrub-handoff-artifacts.sh > "$TEST_ROOT/default.out" 2>&1
default_status=$?
set -e
after_default="$(snapshot)"
assert_equal 1 "$default_status" "default mode must reject present handoff artifacts"
assert_equal "$before" "$after_default" "default mode must preserve repository state"

bash scripts/scrub-handoff-artifacts.sh --help > "$TEST_ROOT/help.out" 2>&1
after_help="$(snapshot)"
assert_equal "$before" "$after_help" "help mode must preserve repository state"

set +e
bash scripts/scrub-handoff-artifacts.sh --apply --unknown > "$TEST_ROOT/unknown.out" 2>&1
unknown_status=$?
set -e
after_unknown="$(snapshot)"
assert_equal 2 "$unknown_status" "unknown arguments must be rejected"
assert_equal "$before" "$after_unknown" "argument rejection must happen before mutation"

mkdir -p "$TEST_ROOT/failing-bin"
printf '#!/usr/bin/env bash\nexit 41\n' > "$TEST_ROOT/failing-bin/rm"
chmod +x "$TEST_ROOT/failing-bin/rm"
set +e
PATH="$TEST_ROOT/failing-bin:$PATH" bash scripts/scrub-handoff-artifacts.sh --apply > "$TEST_ROOT/apply-failure.out" 2>&1
apply_failure_status=$?
set -e
after_apply_failure="$(snapshot)"
assert_equal 41 "$apply_failure_status" "apply must propagate deletion failures"
assert_equal "$before" "$after_apply_failure" "failed apply must preserve repository state"

mkdir -p "$TEST_ROOT/failing-find-bin"
printf '#!/usr/bin/env bash\nexit 43\n' > "$TEST_ROOT/failing-find-bin/find"
chmod +x "$TEST_ROOT/failing-find-bin/find"
set +e
PATH="$TEST_ROOT/failing-find-bin:$PATH" bash scripts/scrub-handoff-artifacts.sh > "$TEST_ROOT/check-failure.out" 2>&1
check_failure_status=$?
set -e
after_check_failure="$(snapshot)"
assert_equal 43 "$check_failure_status" "check must propagate scan failures"
assert_equal "$before" "$after_check_failure" "failed check must preserve repository state"

head_before_apply="$(git rev-parse HEAD)"
bash scripts/scrub-handoff-artifacts.sh --apply > "$TEST_ROOT/apply.out" 2>&1
head_after_apply="$(git rev-parse HEAD)"
assert_equal "$head_before_apply" "$head_after_apply" "apply must not create a commit"
[[ ! -e plans/invoker-handoff.md ]] || fail "apply must remove the tracked allowlisted handoff path"
[[ ! -e plans/invoker-handoff.yaml ]] || fail "apply must remove the untracked allowlisted handoff path"
[[ "$(git diff --cached --name-only)" == staged.txt ]] || fail "apply must not alter staged state"
[[ "$(git diff --name-only)" == $'plans/invoker-handoff.md\nunstaged.txt' ]] || fail "apply must leave allowlisted tracked deletion unstaged and preserve unstaged state"
[[ "$(cat unrelated-untracked.txt)" == untracked-change ]] || fail "apply must preserve unrelated untracked content"
[[ "$(cat tracked.txt)" == tracked-clean ]] || fail "apply must preserve unrelated tracked content"

mkdir -p work
printf 'candidate\n' > work/candidates.json
head_before_residual="$(git rev-parse HEAD)"
set +e
bash scripts/scrub-handoff-artifacts.sh --apply > "$TEST_ROOT/residual.out" 2>&1
residual_status=$?
set -e
assert_equal 1 "$residual_status" "apply must report non-allowlisted handoff artifacts"
assert_equal "$head_before_residual" "$(git rev-parse HEAD)" "residual failure must not create a commit"
[[ "$(cat work/candidates.json)" == candidate ]] || fail "apply must not delete a non-allowlisted path"

printf 'test-scrub-handoff-artifacts: PASS\n'
