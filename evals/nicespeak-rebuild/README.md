# NiceSpeak rebuild eval (Invoker)

Local-only multi-model rebuild evaluation of NiceSpeak into `nicespeak_invoker`.

## Protocol
- Frozen source requirements: NiceSpeak `b4c28368c1f592032172f0bceef1bcd2bc8683e2`
- Agents receive feature specs only (no NiceSpeak source/tests)
- Lineages: `claude/opus`, `codex/gpt-5.5-pro`, `kimi/kimi-k2.6`, `qwen/qwen3-coder-plus`
- One PR per feature workflow; ordered within a lineage; lineages run in parallel
- Autofix: same agent/model, max 1 attempt, included in cost
- Budgets: 250k tokens / 100 tools / 45m per attempt; $250 equivalent-API total

## Commands
```bash
# Render 40 pilot workflows
node evals/nicespeak-rebuild/scripts/render-pilot.mjs

# Isolation preflight (requires Docker)
node evals/nicespeak-rebuild/scripts/preflight-isolation.mjs

# Seed empty target main if needed
bash evals/nicespeak-rebuild/scripts/seed-target-main.sh

# Validate (and optionally submit)
bash evals/nicespeak-rebuild/scripts/run-pilot.sh
SUBMIT=1 bash evals/nicespeak-rebuild/scripts/run-pilot.sh

# Report (after lineages have refs/PRs)
# Writes generated/reports/* and a reviewable snapshot under published/
node evals/nicespeak-rebuild/reporting/report.mjs \
  /path/to/nicespeak_invoker \
  ./evals/nicespeak-rebuild/generated/reports \
  ./evals/nicespeak-rebuild/generated/reports/cost-events.json

# Unit tests for the reporter
node --test evals/nicespeak-rebuild/reporting/report.test.mjs
```

The HTML report is a per-feature Claude / Codex / Qwen comparison (PR links, workflow status, tokens, diff/path Jaccard, acceptance heuristics, strict correctness verdicts, and functional-equivalence findings). It also explains the Qwen #25/#26 failures, records the frozen-head Chrome-to-Slack E2E result, and proposes 16 shared black-box slices for a conformance-gated rerun. `liveMetadata` (gh PR map) is excluded from the frozen content hash. Set `NICESPEAK_EVAL_SKIP_GH=1` to omit live PR fetch.

## Config
Merge `fixtures/invoker-eval-config.snippet.json` into your local Invoker config.
Leave `autoFixAgent` unset so repairs inherit each task's agent/model.
