# Planning vs Execution Tooling

This repo includes local analysis tooling for AI token/cost investigation and planning-vs-execution attribution.

## Scripts

- `scripts/cache_hit_audit.py`
  - Runs `ccusage` audits across local + configured remote targets.
  - Computes deduplicated usage views.
  - Extracts repeated input blocks that drive cache hit rates.
- `scripts/planning_vs_execution_report.py`
  - Splits session activity into `planning` vs `execution` using phrase matching.
  - Generates Codex, Claude, and Combined sections.
  - Produces per-session/per-prompt distributions, Pareto cuts, and tool-call breakdowns with projected cost attribution.
- `scripts/mixpanel_export_usage.py`
  - Converts report JSON/CSV artifacts into Mixpanel events.
  - Applies idempotent `$insert_id` dedupe with local state.
  - Supports high-detail prompt/session export with cardinality controls.

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

## Nightly Export

For productionized nightly Mixpanel publishing with launchd scheduler setup, see:

- `docs/usage-metrics-nightly.md`

Dry-run pipeline:

```bash
bash scripts/nightly_usage_pipeline.sh --dry-run --env-file config/nightly-usage.env
```
