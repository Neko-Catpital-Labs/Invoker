#!/usr/bin/env bash
# Fixture tests for mergify-queue-research watch + linear-issue-create (no network).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

SANDBOXES=()
cleanup() {
  local d
  for d in ${SANDBOXES[@]+"${SANDBOXES[@]}"}; do rm -rf "$d"; done
}
trap cleanup EXIT

fail() { echo "FAIL: $1" >&2; [ -n "${2:-}" ] && { echo "----- log -----" >&2; cat "$2" >&2; }; exit 1; }

mk_sb() {
  sb="$(mktemp -d "${TMPDIR:-/tmp}/test-mergify-queue-research.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/work" "$sb/bin"
}

# ── A. Empty lookback / no activity → no chain ───────────────────────────────
mk_sb
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/Neko-Catpital-Labs/Invoker.git": []
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "mergifyQueueResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        { "repoUrl": "https://github.com/Neko-Catpital-Labs/Invoker.git", "lookbackDays": 30 }
      ]
    }
  }
}
JSON
log="$sb/a.log"
env \
  INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/mergify-queue-research-watch.mjs" > "$log" 2>&1 \
  || fail "A: watch should exit 0" "$log"
grep -q "no new candidates" "$log" || fail "A: expected no-candidates log" "$log"
test "$(find "$sb/work/runs" -name '*.yaml' 2>/dev/null | wc -l | tr -d ' ')" = "0" \
  || fail "A: must not write chain yaml when empty" "$log"
echo "PASS A: empty activity → no chain"

# ── B. New queue event → chain YAML with K research slots ────────────────────
mk_sb
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/Neko-Catpital-Labs/Invoker.git": [
    {
      "date": "2026-08-20",
      "kind": "requeue",
      "title": "requeue PR #9403 check=required-fast / Guardrails",
      "url": "https://github.com/Neko-Catpital-Labs/Invoker/pull/9403",
      "body": "{\"kind\":\"requeue\",\"pr\":9403,\"key\":\"required-fast / Guardrails\"}"
    }
  ]
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "mergifyQueueResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        { "repoUrl": "https://github.com/Neko-Catpital-Labs/Invoker.git", "lookbackDays": 30 }
      ]
    }
  }
}
JSON
log="$sb/b.log"
env \
  INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/mergify-queue-research-watch.mjs" > "$log" 2>&1 \
  || fail "B: watch should exit 0" "$log"
research="$(find "$sb/work/runs" -name '02-research.template.yaml' | head -1)"
test -n "$research" || fail "B: missing research template" "$log"
grep -q "id: research-1" "$research" || fail "B: missing research-1" "$research"
grep -q "id: research-3" "$research" || fail "B: expected K=3 slots" "$research"
grep -q "onFinish: none" "$research" || fail "B: research must be onFinish none" "$research"
file_lin="$(find "$sb/work/runs" -name '03-file-linear.template.yaml' | head -1)"
grep -q "linear-issue-create.mjs" "$file_lin" || fail "B: file-linear must call create script" "$file_lin"
grep -vq "invoker-ready" "$file_lin" || fail "B: must not mention invoker-ready" "$file_lin"
echo "PASS B: queue event → chain with K slots"

# ── C. Duplicate fingerprint → skip ──────────────────────────────────────────
mk_sb
fp="$(node -e "const c=require('crypto');console.log(c.createHash('sha256').update('requeue:requeue PR #9403 check=required-fast / Guardrails'.trim().toLowerCase()).digest('hex').slice(0,16))")"
mkdir -p "$sb/work"
cat > "$sb/work/ledger.json" <<JSON
{ "fingerprints": { "$fp": { "at": "2026-08-01T00:00:00Z" } }, "watermarks": {} }
JSON
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/Neko-Catpital-Labs/Invoker.git": [
    {
      "date": "2026-08-20",
      "kind": "requeue",
      "title": "requeue PR #9403 check=required-fast / Guardrails",
      "url": "https://example.com",
      "body": ""
    }
  ]
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "mergifyQueueResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        "https://github.com/Neko-Catpital-Labs/Invoker.git"
      ]
    }
  }
}
JSON
log="$sb/c.log"
env \
  INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/mergify-queue-research-watch.mjs" > "$log" 2>&1 \
  || fail "C: watch should exit 0" "$log"
grep -q "no new candidates" "$log" || fail "C: expected duplicate skip" "$log"
echo "PASS C: duplicate fingerprint skipped"

# ── C2. Same fingerprint twice in one activity list → one candidate only ─────
mk_sb
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/Neko-Catpital-Labs/Invoker.git": [
    {
      "date": "2026-08-20",
      "kind": "repair-bot-thread",
      "title": "repair-bot-thread PR #9961 PRRT_kwDOSFkSDM6a5nT4",
      "url": "https://example.com/a",
      "body": "{\"kind\":\"repair-bot-thread\"}"
    },
    {
      "date": "2026-08-20",
      "kind": "repair-bot-thread",
      "title": "repair-bot-thread PR #9961 PRRT_kwDOSFkSDM6a5nT4",
      "url": "https://example.com/b",
      "body": "{\"kind\":\"repair-bot-thread-settled\"}"
    },
    {
      "date": "2026-08-20",
      "kind": "requeue",
      "title": "requeue PR #1 ready",
      "url": "https://example.com/c",
      "body": ""
    }
  ]
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "mergifyQueueResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 5,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        "https://github.com/Neko-Catpital-Labs/Invoker.git"
      ]
    }
  }
}
JSON
log="$sb/c2.log"
env \
  INVOKER_MERGIFY_QUEUE_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_MERGIFY_QUEUE_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/mergify-queue-research-watch.mjs" > "$log" 2>&1 \
  || fail "C2: watch should exit 0" "$log"
cands="$(find "$sb/work/runs" -name candidates.json | head -1)"
test -n "$cands" || fail "C2: missing candidates.json" "$log"
count="$(node -e "const d=require('$cands'); console.log(d.candidates.length)")"
test "$count" = "2" || fail "C2: expected 2 unique fingerprints, got $count" "$cands"
fps="$(node -e "const d=require('$cands'); console.log([...new Set(d.candidates.map(c=>c.fingerprint))].length)")"
test "$fps" = "2" || fail "C2: candidate fingerprints must be unique" "$cands"
echo "PASS C2: within-tick fingerprint dedupe"

# ── D. linear-issue-create steal body + skip label; never invoker-ready ───────
mk_sb
cat > "$sb/steal.json" <<'JSON'
{
  "title": "Quarantine batch-only Guardrails flake",
  "verdict": "steal",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "Stop speculative-draft-only Guardrails failures from thrashing admin-bypass",
  "motivation": "Same check fails on queue draft but passes on the individual PR",
  "safetyInvariant": "Individual PR required-check policy unchanged",
  "verify": "bash scripts/test-mergify-queue-research-watch.sh",
  "reviewClaim": "Document and quarantine the batch-only failure signature",
  "reviewLane": "policy",
  "evidence": "requeue PR #9403"
}
JSON
cat > "$sb/skip.json" <<'JSON'
{
  "title": "Skip already-capped requeue",
  "verdict": "skip",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "Do not file a ticket for a normal capped requeue",
  "motivation": "pr-admin-bypass-land already handles this correctly",
  "safetyInvariant": "No product change; documentation of skip only",
  "verify": "test -f scripts/mergify_admin_requeue.py",
  "evidence": "requeue ledger row within retry cap"
}
JSON
cat > "$sb/bin/create-stub" <<STUB
#!/usr/bin/env bash
cat >> "$sb/creates.jsonl"
echo >> "$sb/creates.jsonl"
echo '{"id":"stub","identifier":"STUB-1"}'
STUB
chmod +x "$sb/bin/create-stub"

log="$sb/d-steal.log"
env \
  INVOKER_LINEAR_DRY_RUN=0 \
  INVOKER_LINEAR_CREATE_CMD="$sb/bin/create-stub" \
  INVOKER_LINEAR_TEAM_ID=team-test \
  node "$REPO_ROOT/scripts/linear-issue-create.mjs" --artifact "$sb/steal.json" > "$log" 2>&1 \
  || fail "D-steal: create should exit 0" "$log"
grep -q "Goal:" "$sb/creates.jsonl" || fail "D-steal: body missing Goal" "$sb/creates.jsonl"
grep -q "Motivation:" "$sb/creates.jsonl" || fail "D-steal: body missing Motivation" "$sb/creates.jsonl"
grep -q "Safety invariant:" "$sb/creates.jsonl" || fail "D-steal: body missing Safety" "$sb/creates.jsonl"
grep -q "Verify:" "$sb/creates.jsonl" || fail "D-steal: body missing Verify" "$sb/creates.jsonl"
grep -vq "invoker-ready" "$sb/creates.jsonl" || fail "D-steal: must not include invoker-ready" "$sb/creates.jsonl"

: > "$sb/creates.jsonl"
log="$sb/d-skip.log"
env \
  INVOKER_LINEAR_DRY_RUN=0 \
  INVOKER_LINEAR_CREATE_CMD="$sb/bin/create-stub" \
  INVOKER_LINEAR_TEAM_ID=team-test \
  node "$REPO_ROOT/scripts/linear-issue-create.mjs" --artifact "$sb/skip.json" > "$log" 2>&1 \
  || fail "D-skip: create should exit 0" "$log"
grep -vq "invoker-ready" "$sb/creates.jsonl" || fail "D-skip: must not include invoker-ready" "$sb/creates.jsonl"
grep -q "labels=idea-skip" "$log" || fail "D-skip: expected idea-skip in log" "$log"
echo "PASS D: create body fields + idea-skip; no invoker-ready"

# ── E. Refuse invoker-ready label ────────────────────────────────────────────
mk_sb
cat > "$sb/bad.json" <<'JSON'
{
  "title": "Bad",
  "verdict": "steal",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "g",
  "motivation": "m",
  "safetyInvariant": "s",
  "verify": "true"
}
JSON
log="$sb/e.log"
if env INVOKER_LINEAR_LABEL_NAMES=invoker-ready INVOKER_LINEAR_DRY_RUN=1 \
  node "$REPO_ROOT/scripts/linear-issue-create.mjs" --artifact "$sb/bad.json" > "$log" 2>&1; then
  fail "E: must refuse invoker-ready label" "$log"
fi
grep -qi "Refusing\|invoker-ready" "$log" || fail "E: expected refusal message" "$log"
echo "PASS E: refuses invoker-ready"

echo "All mergify-queue-research fixture tests passed."
