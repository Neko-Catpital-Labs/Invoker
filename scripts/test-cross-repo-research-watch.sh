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

TODAY="$(date -u +%Y-%m-%d)"

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
cat > "$sb/activity.json" <<JSON
{
  "https://github.com/stablyai/orca": [
    {
      "date": "$TODAY",
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
cat > "$sb/activity.json" <<JSON
{
  "https://github.com/stablyai/orca": [
    {
      "date": "$TODAY",
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
  "evidence": "orca #15551",
  "peerLandscape": [
    { "repo": "orca", "approach": "recency-sorted palette", "outcome": "reduced miss rate" }
  ],
  "alternateImplementations": [
    { "approach": "sort by needs_input first", "tradeoffs": "simple, may starve stale failed" },
    { "approach": "weighted score of recency+status", "tradeoffs": "more tunable, more complex" }
  ],
  "adversarialAnalysis": [
    { "objection": "redundant with existing filter", "strength": "low" }
  ],
  "effectivenessMeasurement": {
    "leadingSignals": ["operator clicks needs_input entry within 30s of surfacing"],
    "laggingSignals": ["reduced time-to-first-response on waiting agents"]
  }
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
  "evidence": "land-stack skill exists",
  "effectivenessMeasurement": {
    "leadingSignals": ["no duplicate stacked-PR skill authored within 30d"],
    "laggingSignals": ["zero regressions filed against land-stack for this idea"]
  }
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
grep -q "Peer landscape:" "$sb/creates.jsonl" || fail "D-steal: body missing Peer landscape" "$sb/creates.jsonl"
grep -q "Alternate implementations:" "$sb/creates.jsonl" || fail "D-steal: body missing Alternate implementations" "$sb/creates.jsonl"
grep -q "Adversarial analysis:" "$sb/creates.jsonl" || fail "D-steal: body missing Adversarial analysis" "$sb/creates.jsonl"
grep -q "Effectiveness measurement:" "$sb/creates.jsonl" || fail "D-steal: body missing Effectiveness measurement" "$sb/creates.jsonl"
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

# ── F. Fail-closed create without effectivenessMeasurement ───────────────────
mk_sb
cat > "$sb/steal-no-effectiveness.json" <<'JSON'
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
log="$sb/f.log"
if env INVOKER_LINEAR_DRY_RUN=1 \
  node "$REPO_ROOT/scripts/linear-issue-create.mjs" --artifact "$sb/steal-no-effectiveness.json" > "$log" 2>&1; then
  fail "F: create must fail closed without effectivenessMeasurement" "$log"
fi
grep -qi "Effectiveness measurement" "$log" || fail "F: expected missing-effectiveness error message" "$log"
echo "PASS F: fails closed without effectivenessMeasurement"

mk_sb
cat > "$sb/activity.json" <<JSON
{
  "https://github.com/stablyai/orca": [
    { "date": "$TODAY", "kind": "feat", "title": "feat(x): one idea", "url": "https://github.com/stablyai/orca/pull/1", "body": "" }
  ]
}
JSON
log="$sb/g.log"
env \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON='{"crossRepoResearch":{"linearTeamId":"team-from-config","maxCandidatesPerSource":2,"maps":{"https://github.com/Neko-Catpital-Labs/Invoker.git":[{"repoUrl":"https://github.com/stablyai/orca","lookbackDays":30}]}}}' \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1 \
  || fail "G: watch should exit 0" "$log"
file_lin="$(find "$sb/work/runs" -name '03-file-linear.template.yaml' | head -1)"
test -n "$file_lin" || fail "G: missing file-linear template" "$log"
run_dir="$(dirname "$file_lin")"
file_cmd="$(node -e '
const text = require("fs").readFileSync(process.argv[1], "utf8");
const block = text.split("- id: file-linear-tickets")[1];
process.stdout.write(JSON.parse(block.match(/\n    command: (".*")\n/)[1]));
' "$file_lin")"
cat > "$sb/bin/create-stub" <<STUB
#!/usr/bin/env bash
cat >> "$sb/creates.jsonl"
echo >> "$sb/creates.jsonl"
echo '{"id":"stub","identifier":"STUB-1"}'
STUB
chmod +x "$sb/bin/create-stub"

log="$sb/g-empty.log"
if env -u INVOKER_LINEAR_TEAM_ID INVOKER_LINEAR_CREATE_CMD="$sb/bin/create-stub" \
  bash -c "$file_cmd" > "$log" 2>&1; then
  fail "G-empty: file-linear must fail when no research artifact exists" "$log"
fi

cat > "$run_dir/research-1.json" <<'JSON'
{
  "title": "Steal one idea",
  "verdict": "steal",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "g", "motivation": "m", "safetyInvariant": "s", "verify": "true",
  "reviewClaim": "c", "reviewLane": "behavior", "evidence": "e",
  "peerLandscape": [{ "repo": "orca", "approach": "a", "outcome": "o" }],
  "alternateImplementations": [{ "approach": "a", "tradeoffs": "t" }, { "approach": "b", "tradeoffs": "t" }],
  "adversarialAnalysis": [{ "objection": "o", "strength": "low" }],
  "effectivenessMeasurement": { "leadingSignals": ["l"], "laggingSignals": ["l"] }
}
JSON
log="$sb/g-one.log"
env -u INVOKER_LINEAR_TEAM_ID INVOKER_LINEAR_CREATE_CMD="$sb/bin/create-stub" \
  bash -c "$file_cmd" > "$log" 2>&1 \
  || fail "G-one: file-linear should exit 0 with one research artifact and no team id in env" "$log"
grep -q '"teamId":"team-from-config"' "$sb/creates.jsonl" \
  || fail "G-one: create payload must carry the configured team id" "$sb/creates.jsonl"
echo "PASS G: file-linear carries configured team id and fails with no research"

mk_sb
mkdir -p "$sb/home" "$sb/cwd"
log="$sb/h.log"
cat > "$sb/activity.json" <<JSON
{ "https://github.com/stablyai/orca": [ { "date": "$TODAY", "kind": "feat", "title": "feat(y): idea", "url": "u", "body": "" } ] }
JSON
(
  cd "$sb/cwd"
  env -u INVOKER_CROSS_REPO_RESEARCH_WORK_DIR \
    HOME="$sb/home" \
    INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON='{"crossRepoResearch":{"linearTeamId":"team-test","maxCandidatesPerSource":1,"maps":{"https://github.com/Neko-Catpital-Labs/Invoker.git":[{"repoUrl":"https://github.com/stablyai/orca","lookbackDays":30}]}}}' \
    INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
    INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 \
    node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs"
) > "$log" 2>&1 || fail "H: watch should exit 0" "$log"
test ! -e "$sb/cwd/runs" || fail "H: run artifacts must not land in the current directory" "$log"
test -f "$sb/home/.invoker/cross-repo-research/ledger.json" \
  || fail "H: default work dir must be ~/.invoker/cross-repo-research" "$log"
for tpl in 01-discover.yaml 02-research.template.yaml 03-file-linear.template.yaml; do
  f="$(find "$sb/home/.invoker/cross-repo-research/runs" -name "$tpl" | head -1)"
  test -n "$f" || fail "H: missing $tpl" "$log"
  grep -q '^baseBranch:' "$f" || fail "H: $tpl must declare top-level baseBranch for submit-workflow-chain" "$f"
done
echo "PASS H: default work dir under home; chain templates declare baseBranch"

mk_sb
cat > "$sb/activity.json" <<JSON
{ "https://github.com/stablyai/orca": [ { "date": "$TODAY", "kind": "feat", "title": "feat(live): idea", "url": "u", "body": "" } ] }
JSON
cat > "$sb/bin/invoker-cli" <<STUB
#!/usr/bin/env bash
n=\$(( \$(ls "$sb/calls" 2>/dev/null | grep -c "\\.args\$") + 1 ))
mkdir -p "$sb/calls"
printf '%s\n' "\$*" > "$sb/calls/\$n.args"
cp "\$2" "$sb/calls/\$n.yaml"
printf '{"workflow":{"id":"wf-live-%s"}}\n' "\$n"
STUB
chmod +x "$sb/bin/invoker-cli"
log="$sb/i.log"
env \
  INVOKER_CROSS_REPO_RESEARCH_CLI="$sb/bin/invoker-cli" \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON='{"crossRepoResearch":{"linearTeamId":"team-test","maxCandidatesPerSource":1,"maps":{"https://github.com/Neko-Catpital-Labs/Invoker.git":[{"repoUrl":"https://github.com/stablyai/orca","lookbackDays":30}]}}}' \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1 \
  || fail "I: watch should exit 0 with a live submit stub" "$log"
test "$(ls "$sb/calls" | grep -c '\.args$')" = "3" || fail "I: expected three live submits" "$log"
for n in 1 2 3; do
  grep -q -- '^run .* --live --json$' "$sb/calls/$n.args" || fail "I: submit $n must use run --live --json" "$sb/calls/$n.args"
done
grep -q 'workflowId: "wf-live-1"' "$sb/calls/2.yaml" || fail "I: research must depend on discover workflow id" "$sb/calls/2.yaml"
grep -q 'workflowId: "wf-live-2"' "$sb/calls/3.yaml" || fail "I: file-linear must depend on research workflow id" "$sb/calls/3.yaml"
grep -q '^baseBranch: master$' "$sb/calls/1.yaml" || fail "I: discover must stay on master" "$sb/calls/1.yaml"
grep -q '^baseBranch: master$' "$sb/calls/2.yaml" || fail "I: research must stay on master" "$sb/calls/2.yaml"
grep -q '^baseBranch: master$' "$sb/calls/3.yaml" || fail "I: file-linear must stay on master" "$sb/calls/3.yaml"
grep -q '"fingerprints": {}' "$sb/work/ledger.json" && fail "I: ledger must record the submitted candidate" "$sb/work/ledger.json"

mk_sb
cat > "$sb/activity.json" <<JSON
{ "https://github.com/stablyai/orca": [ { "date": "$TODAY", "kind": "feat", "title": "feat(live): idea", "url": "u", "body": "" } ] }
JSON
printf '#!/usr/bin/env bash\necho "not json"\n' > "$sb/bin/invoker-cli"
chmod +x "$sb/bin/invoker-cli"
log="$sb/i-bad.log"
if env \
  INVOKER_CROSS_REPO_RESEARCH_CLI="$sb/bin/invoker-cli" \
  INVOKER_CROSS_REPO_RESEARCH_CONFIG_JSON='{"crossRepoResearch":{"linearTeamId":"team-test","maxCandidatesPerSource":1,"maps":{"https://github.com/Neko-Catpital-Labs/Invoker.git":[{"repoUrl":"https://github.com/stablyai/orca","lookbackDays":30}]}}}' \
  INVOKER_CROSS_REPO_RESEARCH_ACTIVITY_FIXTURE="$sb/activity.json" \
  INVOKER_CROSS_REPO_RESEARCH_WORK_DIR="$sb/work" \
  node "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" > "$log" 2>&1; then
  fail "I-bad: submit without a workflow id must fail the sweep" "$log"
fi
test ! -f "$sb/work/ledger.json" || fail "I-bad: failed submit must not write the ledger" "$sb/work/ledger.json"
echo "PASS I: chain submits live to the owner on master with upstream ids; missing id fails"

mk_sb
cat > "$sb/echo.json" <<'JSON'
{
  "title": "Skip idea that echoes the prompt",
  "verdict": "skip",
  "repo": "https://github.com/Neko-Catpital-Labs/Invoker.git",
  "goal": "g",
  "motivation": "m",
  "safetyInvariant": "Writes only research-1.json; no Linear ticket and no invoker-ready labeling.",
  "verify": "true",
  "effectivenessMeasurement": { "leadingSignals": ["l"], "laggingSignals": ["l"] }
}
JSON
cat > "$sb/bin/create-stub" <<STUB
#!/usr/bin/env bash
cat >> "$sb/creates.jsonl"
echo >> "$sb/creates.jsonl"
echo '{"id":"stub","identifier":"STUB-1"}'
STUB
chmod +x "$sb/bin/create-stub"
log="$sb/j.log"
env INVOKER_LINEAR_CREATE_CMD="$sb/bin/create-stub" INVOKER_LINEAR_TEAM_ID=team-test \
  node "$REPO_ROOT/scripts/linear-issue-create.mjs" --artifact "$sb/echo.json" > "$log" 2>&1 \
  || fail "J: an artifact that only mentions the ready label in prose must still file" "$log"
grep -qi 'invoker-ready' "$sb/creates.jsonl" && fail "J: filed body must not contain the ready label name" "$sb/creates.jsonl"
if grep -n 'invoker-ready' "$REPO_ROOT/scripts/cross-repo-research-watch.mjs" | grep -q "'Do not"; then
  fail "J: research prompts must not name the ready label"
fi
echo "PASS J: prose mention of the ready label is neutralized; prompts do not name it"

grep -qF "node $REPO_ROOT/scripts/linear-issue-create.mjs --artifact" "$file_lin" \
  || fail "K: file-linear must run the generating checkout's linear-issue-create.mjs by absolute path" "$file_lin"
echo "PASS K: file-linear runs the generator's own filing script"

echo "All cross-repo-research fixture tests passed."
