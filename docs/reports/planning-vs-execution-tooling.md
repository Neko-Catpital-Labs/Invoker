# Planning vs Execution Tooling

This repo includes local analysis tooling for AI token/cost investigation and
planning-vs-execution attribution.

## Scripts

- `scripts/cache_hit_audit.py`
  - Runs `ccusage` audits across local + configured remote targets.
  - Computes deduplicated usage views.
  - Extracts repeated input blocks that drive cache hit rates.
- `scripts/planning_vs_execution_report.py`
  - Splits session activity into `planning` vs `execution` using phrase matching.
  - Generates Codex, Claude, and Combined sections.
  - Produces per-session/per-prompt distributions, Pareto cuts, and tool-call
    breakdowns with projected cost attribution.

## Regenerate

Run from repo root:

```bash
python3 scripts/cache_hit_audit.py --output cache-hit-audit-report.json --top 50
python3 scripts/planning_vs_execution_report.py --out-dir reports
```

Primary outputs:

- `reports/planning-vs-execution-report.json`
- `reports/planning-vs-execution-sessions.csv`
- `reports/planning-vs-execution-prompts.csv`
- `reports/planning-vs-execution-tool-breakdown.csv`
- `reports/planning-vs-execution-summary.md`

## Methodology notes

- Planning classifier phrases:
  - `plan-to-invoker`
  - `/plan-to-invoker`
  - `submit to invoker`
  - `create invoker plan`
  - `convert to invoker`
- Cost allocation:
  - Per model, costs are proportionally attributed from local `ccusage` totals.
  - Effective input uses `input_tokens + 0.1 * cached_input_tokens`.
- Tool projected cost:
  - Uniform-rate attribution per session:
    - `session_cost / session_tool_calls`
    - multiplied by tool call counts in that session.
  - This is useful for ranking tool families but does not capture per-call
    token variance.
