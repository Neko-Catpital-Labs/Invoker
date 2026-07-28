#!/usr/bin/env bash
# Behavior test for scripts/cron-coderabbit-address.sh after the repair-workflow
# cutover. No real Invoker, no network, no repo checkout.
#
# Covers:
#   A. Dry-run: logs the intended repair-workflow submission, writes a YAML plan,
#      and never calls the submit command.
#   B. Real run: submits exactly once, records the success marker, and surfaces
#      the workflow id from the submit path.
#   C. Dedup: once the marker is recorded, the same feedback batch is skipped.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

WORKER="$REPO_ROOT/scripts/cron-coderabbit-address.sh"
UPDATED="2026-07-01T12:34:56Z"
HEAD_BRANCH="feature/coderabbit-fix"
BASE_BRANCH="main"
PR_TITLE="Keep PR title"
PR_BODY="Keep PR body"
COMMENT_BODY="Please add a null guard before reading response.data"

SANDBOXES=()
cleanup() { local d; for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do rm -rf "$d"; done; return 0; }
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "----- log -----" >&2; cat "$2" >&2; }; exit 1; }

run_worker() {
  local dry_run="$1"
  sb="$(mktemp -d "${TMPDIR:-/tmp}/test-coderabbit-submit.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/bin" "$sb/work"
  calls="$sb/submit-calls"
  ledger="$sb/ledger.tsv"
  : > "$ledger"

  cat > "$sb/bin/gh" <<GH
#!/usr/bin/env bash
case "\${1:-}" in
  pr)
    case "\${2:-}" in
      list)
        printf '%s\n' '[{"number":777,"url":"https://github.com/owner/repo/pull/777","headRefName":"$HEAD_BRANCH","baseRefName":"$BASE_BRANCH","title":"$PR_TITLE"}]'
        exit 0 ;;
      view)
        printf '%s\n' '{"title":"$PR_TITLE","body":"$PR_BODY","headRefName":"$HEAD_BRANCH","baseRefName":"$BASE_BRANCH"}'
        exit 0 ;;
    esac ;;
  api)
    case "\${2:-}" in
      */pulls/*/comments)
        printf '%s\n' '[{"user":{"login":"coderabbitai[bot]"},"body":"$COMMENT_BODY","updated_at":"$UPDATED","path":"src/app.ts","html_url":"https://github.com/owner/repo/pull/777#discussion_r1"}]'
        exit 0 ;;
      */issues/*/comments)
        printf '[]\n'
        exit 0 ;;
    esac ;;
esac
echo "fake gh: unhandled: \$*" >&2
exit 1
GH
  chmod +x "$sb/bin/gh"

  cat > "$sb/review-gate-empty.sh" <<'RG'
#!/usr/bin/env bash
printf '{}\n'
RG
  chmod +x "$sb/review-gate-empty.sh"

  cat > "$sb/bin/submit-stub" <<STUB
#!/usr/bin/env bash
echo "\$1" >> "$calls"
printf 'Workflow ID: wf-coderabbit-submit-test\n'
exit 0
STUB
  chmod +x "$sb/bin/submit-stub"

  log="$sb/worker.log"
  env \
    PATH="$sb/bin:$PATH" \
    INVOKER_PR_CRON_DRY_RUN="$dry_run" \
    INVOKER_PR_CODERABBIT_STATE_FILE="$ledger" \
    INVOKER_PR_CRON_LOCK="$sb/coderabbit.lock" \
    INVOKER_PR_CRON_WORKDIR="$sb/work" \
    INVOKER_PR_CRON_REVIEW_GATE_CMD="$sb/review-gate-empty.sh" \
    INVOKER_PR_CODERABBIT_SUBMIT_CMD="$sb/bin/submit-stub" \
    INVOKER_PR_CODERABBIT_REPO_URL="git@github.com:Neko-Catpital-Labs/Invoker.git" \
    bash "$WORKER" > "$log" 2>&1 || true
}

# A. Dry-run: intended submission only; valid YAML plan.
run_worker 1
[ ! -s "$calls" ] || fail "A: submit command must not run in dry-run" "$log"
grep -q "would submit repair workflow" "$log" \
  || fail "A: dry-run did not log the intended repair-workflow submission" "$log"
plan="$(printf '%s\n' "$sb"/work/coderabbit-pr-777-*.yaml | sed -n '1p')"
[ -f "$plan" ] || fail "A: expected generated repair plan YAML" "$log"
PLAN="$plan" UPDATED="$UPDATED" HEAD_BRANCH="$HEAD_BRANCH" BASE_BRANCH="$BASE_BRANCH" COMMENT_BODY="$COMMENT_BODY" PR_BODY="$PR_BODY" node <<'NODE' >/dev/null \
  || fail "A: generated plan YAML is not the expected repair-workflow shape" "$log"
const YAML = require("yaml");
const fs = require("fs");
const d = YAML.parse(fs.readFileSync(process.env.PLAN, "utf8"));
if (d.onFinish !== "merge") throw new Error("onFinish=" + d.onFinish);
if (d.mergeMode !== "manual") throw new Error("mergeMode=" + d.mergeMode);
// baseBranch AND featureBranch must both be the PR head branch, so the fix
// layers on top of the PR's commits instead of rebuilding from the PR base.
if (d.baseBranch !== process.env.HEAD_BRANCH) throw new Error("baseBranch=" + d.baseBranch);
if (d.featureBranch !== process.env.HEAD_BRANCH) throw new Error("featureBranch=" + d.featureBranch);
if (!Array.isArray(d.tasks) || d.tasks.length !== 1) throw new Error("expected one task");
if (d.tasks[0].executionAgent !== "omp") throw new Error("executionAgent=" + d.tasks[0].executionAgent);
const prompt = d.tasks[0].prompt || "";
if (!prompt.includes("do not run 'git push' manually")) throw new Error("missing no-push instruction");
if (!prompt.includes(process.env.COMMENT_BODY)) throw new Error("missing comment body");
if (!prompt.includes(process.env.PR_BODY)) throw new Error("missing PR body context");
if (!prompt.includes(process.env.UPDATED)) throw new Error("missing feedback timestamp");
NODE
echo "  A ok: dry-run writes the repair workflow plan and does not submit"

# B. Real run: submits once, records marker, surfaces workflow id.
run_worker 0
[ "$(wc -l < "$calls")" -eq 1 ] || fail "B: expected exactly one submission" "$log"
grep -q "coderabbit-pr-777-" "$calls" || fail "B: submitted the wrong plan path" "$log"
awk -F '\t' -v marker="$UPDATED" '$1=="coderabbit" && $2=="777" && $3==marker { found=1 } END { exit found ? 0 : 1 }' "$ledger" \
  || fail "B: success marker was not recorded" "$log"
grep -q "submitted CodeRabbit repair workflow wf-coderabbit-submit-test" "$log" \
  || fail "B: workflow id was not surfaced after submit" "$log"
echo "  B ok: real run submits once and records the feedback marker"

# C. Dedup: same feedback batch skips after marker recorded.
env \
  PATH="$sb/bin:$PATH" \
  INVOKER_PR_CRON_DRY_RUN=0 \
  INVOKER_PR_CODERABBIT_STATE_FILE="$ledger" \
  INVOKER_PR_CRON_LOCK="$sb/coderabbit.lock" \
  INVOKER_PR_CRON_WORKDIR="$sb/work" \
  INVOKER_PR_CRON_REVIEW_GATE_CMD="$sb/review-gate-empty.sh" \
  INVOKER_PR_CODERABBIT_SUBMIT_CMD="$sb/bin/submit-stub" \
  INVOKER_PR_CODERABBIT_REPO_URL="git@github.com:Neko-Catpital-Labs/Invoker.git" \
  bash "$WORKER" > "$sb/worker2.log" 2>&1 || true
grep -q "no new CodeRabbit comments since $UPDATED; skip" "$sb/worker2.log" \
  || fail "C: same feedback batch did not dedup after marker was recorded" "$sb/worker2.log"
[ "$(wc -l < "$calls")" -eq 1 ] || fail "C: dedup run must not submit again" "$sb/worker2.log"
echo "  C ok: same feedback batch is skipped after submission marker"

echo "PASS: coderabbit repair workflow submission verified (dry-run, submit, dedup)"
exit 0
