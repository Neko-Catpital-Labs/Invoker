#!/usr/bin/env bash
# Fixture tests for cross-repo-research watch + linear-issue-create (no network).
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
  sb="$(mktemp -d "${TMPDIR:-/tmp}/test-cross-repo-research.XXXXXX")"
  SANDBOXES+=("$sb")
  mkdir -p "$sb/work" "$sb/bin"
}

# ── A. Empty lookback / no activity → no chain ───────────────────────────────
mk_sb
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/stablyai/orca": []
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "crossRepoResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        { "repoUrl": "https://github.com/stablyai/orca", "lookbackDays": 30 }
      ]
    }
  }
}
JSON
log="$sb/a.log"
env \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1 \
  || fail "A: watch should exit 0" "$log"
grep -q "no new candidates" "$log" || fail "A: expected no-candidates log" "$log"
test "$(find "$sb/work/runs" -name '*.yaml' 2>/dev/null | wc -l | tr -d ' ')" = "0" \
  || fail "A: must not write chain yaml when empty" "$log"
echo "PASS A: empty activity → no chain"

# ── B. New feat → chain YAML with K research slots ───────────────────────────
mk_sb
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/stablyai/orca": [
    {
      "date": "2026-08-20",
      "kind": "feat",
      "title": "feat(cmd-j): rank palette results by recency",
      "url": "https://github.com/stablyai/orca/pull/15551",
      "body": "Cmd+J search ranked by recency"
    }
  ]
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "crossRepoResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        { "repoUrl": "https://github.com/stablyai/orca", "lookbackDays": 30 }
      ]
    }
  }
}
JSON
log="$sb/b.log"
env \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1 \
  || fail "B: watch should exit 0" "$log"
research="$(find "$sb/work/runs" -name '02-research.template.yaml' | head -1)"
test -n "$research" || fail "B: missing research template" "$log"
grep -q "id: research-1" "$research" || fail "B: missing research-1" "$research"
grep -q "id: research-3" "$research" || fail "B: expected K=3 slots" "$research"
grep -q "onFinish: none" "$research" || fail "B: research must be onFinish none" "$research"
for lens in fit peers implementations adversarial effectiveness; do
  grep -q "id: research-1-${lens}" "$research" || fail "B: missing lens id research-1-${lens}" "$research"
done
grep -q "id: research-1-synthesis" "$research" || fail "B: missing synthesis task for slot 1" "$research"
grep -q "effectivenessMeasurement" "$research" || fail "B: synthesis must require effectivenessMeasurement" "$research"
file_lin="$(find "$sb/work/runs" -name '03-file-linear.template.yaml' | head -1)"
grep -q "linear-issue-create.mjs" "$file_lin" || fail "B: file-linear must call create script" "$file_lin"
grep -vq "invoker-ready" "$file_lin" || fail "B: must not mention invoker-ready" "$file_lin"
grep -q "id: scrub-handoff-artifacts" "$file_lin" || fail "B: file-linear chain missing scrub-handoff-artifacts" "$file_lin"
grep -q "scrub-handoff-artifacts.sh" "$file_lin" || fail "B: scrub task must run scrub-handoff-artifacts.sh" "$file_lin"
echo "PASS B: feat activity → chain with K slots"

# ── C. Duplicate fingerprint → skip ──────────────────────────────────────────
mk_sb
# Seed ledger with the fingerprint of the feat title
fp="$(node -e "const c=require('crypto');console.log(c.createHash('sha256').update('feat:feat(cmd-j): rank palette results by recency').digest('hex').slice(0,16))")"
mkdir -p "$sb/work"
cat > "$sb/work/ledger.json" <<JSON
{ "fingerprints": { "$fp": { "at": "2026-08-01T00:00:00Z" } }, "watermarks": {} }
JSON
cat > "$sb/activity.json" <<'JSON'
{
  "https://github.com/stablyai/orca": [
    {
      "date": "2026-08-20",
      "kind": "feat",
      "title": "feat(cmd-j): rank palette results by recency",
      "url": "https://example.com",
      "body": ""
    }
  ]
}
JSON
cat > "$sb/config.json" <<'JSON'
{
  "crossRepoResearch": {
    "linearTeamId": "team-test",
    "maxCandidatesPerSource": 3,
    "maps": {
      "https://github.com/Neko-Catpital-Labs/Invoker.git": [
        "https://github.com/stablyai/orca"
      ]
    }
  }
}
JSON
log="$sb/c.log"
env \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON="$(cat "$sb/config.json")" \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1 \
  || fail "C: watch should exit 0" "$log"
grep -q "no new candidates" "$log" || fail "C: expected duplicate skip" "$log"
echo "PASS C: duplicate fingerprint skipped"

# ── D. linear-issue-create steal body + skip label; never invoker-ready ───────
mk_sb
cat > "$sb/steal.json" <<'JSON'
{
  "title": "Steal Cmd+K recency ranking",
  "verdict": "steal",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "Rank Needs Attention by needs_input before failed",
  "motivation": "Orca ranked palette by recency; operators miss waiting agents",
  "safetyInvariant": "Attention sort only; no worker behavior change",
  "verify": "cd packages/ui && pnpm test -- workflow-progress-surfaces",
  "reviewClaim": "needs_input ranks above failed in attention entries",
  "reviewLane": "behavior",
  "evidence": "orca #15551"
}
JSON
cat > "$sb/skip.json" <<'JSON'
{
  "title": "Skip stacked PRs product",
  "verdict": "skip",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "Do not rebuild stacked PR UX",
  "motivation": "Invoker already orchestrates stacked PRs",
  "safetyInvariant": "No product change; documentation of skip only",
  "verify": "test -f skills/land-stack/SKILL.md",
  "evidence": "land-stack skill exists"
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
# stub receives labelIds only after network resolve; in create-cmd mode labels are in payload without ids.
# Ensure skip path does not add invoker-ready and create succeeds.
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

echo "All cross-repo-research fixture tests passed."
