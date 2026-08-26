#!/usr/bin/env bash
# Validate and optionally submit the four lineage pilot chains.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
EVAL_ROOT="$ROOT/evals/nicespeak-rebuild"
# shellcheck disable=SC1091
source "$EVAL_ROOT/scripts/eval-env.sh"
GENERATED="$EVAL_ROOT/generated/pilot"
SUBMIT="${SUBMIT:-0}"
GATE_POLICY="${GATE_POLICY:-review_ready}"

cd "$ROOT"
node "$EVAL_ROOT/scripts/render-pilot.mjs"

# Cross-model prompt hash equality
node -e '
const fs = require("fs");
const index = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const [featureId, hash] of Object.entries(index.crossModelPromptHashes)) {
  for (const lineage of index.lineages) {
    const entry = lineage.chain.find((c) => c.featureId === featureId);
    if (!entry) throw new Error("missing " + featureId + " for " + lineage.id);
    if (entry.crossModelPromptHash !== hash) {
      throw new Error("hash drift " + featureId + " " + lineage.id);
    }
  }
}
console.log("CROSS_MODEL_PROMPT_HASHES_OK");
' "$GENERATED/index.json"

# skill-doctor on first workflow of each lineage (templates retain __UPSTREAM__ until chain submit)
for lineage in claude codex kimi qwen; do
  plan="$(ls "$GENERATED/$lineage"/01-*.yaml | head -1)"
  echo "skill-doctor $plan"
  bash skills/plan-to-invoker/scripts/skill-doctor.sh "$plan"
done

if [[ "$SUBMIT" != "1" ]]; then
  echo "RENDER_VALIDATE_OK (set SUBMIT=1 to submit chains)"
  exit 0
fi

for lineage in claude codex kimi qwen; do
  mapfile -t files < <(ls "$GENERATED/$lineage"/*.yaml | sort)
  first="${files[0]}"
  rest=("${files[@]:1}")
  echo "Submitting lineage=$lineage"
  ./scripts/submit-workflow-chain.sh --gate-policy "$GATE_POLICY" "$first" "${rest[@]}"
done

echo "SUBMITTED_ALL_LINEAGES"
