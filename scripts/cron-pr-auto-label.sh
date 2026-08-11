#!/usr/bin/env bash
set -euo pipefail

# Auto-labels open, self-authored PRs with admin-bypass when either:
#   (a) the PR title case-insensitively mentions refactor, bugfix, or repro
#       -- matches the existing "[Bugfix: ...]" / "[REFACTOR: ...]" title tag
#       convention already used across this repo's own stacked PRs, or
#   (b) every changed file in the PR is a test file.
#
# The label add is submitted as a real Invoker command (scratch execution,
# mergeMode: no_op) via headless_mutation, never a bare `gh` mutation from
# this script's own process, so it is tracked like any other Invoker task.
#
# Coordination contract:
#   - only ADDS admin-bypass; never removes any label
#   - skips draft PRs, PRs already labeled admin-bypass, and PRs labeled
#     merge-hold (never overrides an explicit hold)
#   - only considers PRs authored by $PR_AUTHOR in $TARGET_REPO
#
# Env (all optional):
#   INVOKER_PR_CRON_DRY_RUN=1   log the plan instead of submitting

# shellcheck source=scripts/cron-pr-lib.sh
source "$(dirname "$0")/cron-pr-lib.sh"

# ---------------------------------------------------------------------------
# Pure matching logic (no network access) -- directly unit-testable.
# ---------------------------------------------------------------------------

title_matches_marker() {
  grep -qiE 'refactor|bugfix|repro' <<<"$1"
}

# Mirrors scripts/review-unit-rules.mjs's test-file path classifier so
# "test-only" means the same thing here as it does everywhere else in the
# repo's own tooling.
is_test_file_path() {
  [[ "$1" == *"/e2e/"* ]] && return 0
  [[ "$1" == *"/__tests__/"* ]] && return 0
  [[ "$1" =~ \.(spec|test)\.[^.]+$ ]] && return 0
  return 1
}

pr_is_test_only_diff() {
  local files="$1"
  [ -z "$files" ] && return 1
  local f
  while IFS= read -r f; do
    [ -z "$f" ] && continue
    is_test_file_path "$f" || return 1
  done <<<"$files"
  return 0
}

# When sourced (e.g. by tests), expose the functions above without running
# the scan/submit flow below.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  return 0
fi

cron_lock

# ---------------------------------------------------------------------------
# Scan + submit
# ---------------------------------------------------------------------------

if [ -n "${INVOKER_PR_AUTO_LABEL_PLAN_DIR:-}" ]; then
  PLAN_DIR="$INVOKER_PR_AUTO_LABEL_PLAN_DIR"
  mkdir -p "$PLAN_DIR"
else
  PLAN_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-auto-label-plans.XXXXXX")"
  trap 'rm -rf "$PLAN_DIR"' EXIT
fi

prs_json="$(gh_json pr list --repo "$TARGET_REPO" --author "$PR_AUTHOR" --state open \
  --json number,title,isDraft,labels --limit 100)" || {
  log_line "could not list PRs; exiting"
  exit 0
}

labeled=0
while IFS= read -r pr; do
  [ -z "$pr" ] && continue
  num="$(jq -r '.number' <<<"$pr")"

  if [ "$(jq -r '.isDraft' <<<"$pr")" = "true" ]; then
    continue
  fi
  if jq -e '.labels[]? | select(.name == "admin-bypass")' <<<"$pr" >/dev/null; then
    continue
  fi
  if jq -e '.labels[]? | select(.name == "merge-hold")' <<<"$pr" >/dev/null; then
    log_line "PR #$num: merge-hold present; skipping"
    continue
  fi

  title="$(jq -r '.title' <<<"$pr")"
  eligible=0
  reason=""
  if title_matches_marker "$title"; then
    eligible=1
    reason="title marker"
  else
    files="$(gh_json pr view "$num" --repo "$TARGET_REPO" --json files -q '.files[].path' || true)"
    if pr_is_test_only_diff "$files"; then
      eligible=1
      reason="test-only diff"
    fi
  fi
  [ "$eligible" -eq 1 ] || continue

  plan_file="$PLAN_DIR/label-pr-$num.yaml"
  {
    printf 'name: "auto-label-pr-%s-admin-bypass"\n' "$num"
    printf 'scratch: true\n'
    printf 'onFinish: none\n'
    printf 'mergeMode: no_op\n'
    printf 'tasks:\n'
    printf '  - id: label\n'
    printf '    description: "Add admin-bypass label to PR #%s (%s)"\n' "$num" "$reason"
    printf '    command: gh pr edit %s --repo %s --add-label admin-bypass\n' "$num" "$(shell_quote "$TARGET_REPO")"
    printf '    dependencies: []\n'
  } > "$plan_file"

  if [ "$DRY_RUN" = "1" ]; then
    log_line "PR #$num: DRY-RUN would submit admin-bypass label ($reason)"
    continue
  fi

  if output="$(headless_mutation run "$plan_file" 2>&1)"; then
    labeled=$((labeled + 1))
    log_line "PR #$num: submitted admin-bypass label task ($reason)"
  else
    while IFS= read -r line; do
      [ -n "$line" ] || continue
      log_line "PR #$num: submit failed: $line"
    done <<<"$output"
  fi
done < <(jq -c '.[]' <<<"$prs_json")

log_line "auto-label scan complete; labeled $labeled PR(s)"
