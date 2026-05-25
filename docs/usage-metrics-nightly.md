# Nightly Usage Metrics (Mixpanel)

This pipeline publishes nightly token/cost/cache analytics to Mixpanel so tool consumption can be sliced by model, workflow bucket, and prompt/tool drivers.

## What It Sends

The exporter publishes five event families:

- `usage_daily_rollup`
- `usage_session`
- `usage_prompt`
- `usage_tool_breakdown`
- `usage_cache_driver`

Source artifacts:

- `cache-hit-audit-report.json`
- `reports/planning-vs-execution-report.json`
- `reports/planning-vs-execution-sessions.csv`
- `reports/planning-vs-execution-prompts.csv`
- `reports/planning-vs-execution-tool-breakdown.csv`

## Setup

1. Copy env template:

```bash
cp config/nightly-usage.env.example config/nightly-usage.env
```

2. Fill credentials in `config/nightly-usage.env`:
   - Required: `MIXPANEL_TOKEN`
   - Auth (choose one):
     - `MIXPANEL_API_SECRET`
     - or `MIXPANEL_SERVICE_ACCOUNT_USER` + `MIXPANEL_SERVICE_ACCOUNT_PASS`

3. Optional tunables:
   - `MAX_EVENTS_PER_FAMILY`
   - `MAX_UNIQUE_PROMPT_HASHES_PER_DAY`
   - `MAX_STATE_IDS`
   - `MIXPANEL_BATCH_SIZE`
   - `USAGE_PIPELINE_LOG_DIR`

## Manual Runs

Dry run:

```bash
bash scripts/nightly_usage_pipeline.sh --dry-run --env-file config/nightly-usage.env
```

Fast dry-run using existing artifacts only:

```bash
bash scripts/nightly_usage_pipeline.sh --dry-run --env-file config/nightly-usage.env --skip-cache-audit --skip-report
```

Live run:

```bash
bash scripts/nightly_usage_pipeline.sh --env-file config/nightly-usage.env
```

Backfill a specific date:

```bash
bash scripts/nightly_usage_pipeline.sh --date 2026-05-25 --env-file config/nightly-usage.env
```

Replay/backfill without local-state suppression (safe for resubmits):

```bash
bash scripts/nightly_usage_pipeline.sh --date 2026-05-25 --env-file config/nightly-usage.env --ignore-local-state
```

## launchd Scheduling (Local Machine)

Install nightly launchd job at 02:10 local:

```bash
bash scripts/install-nightly-usage-launchd.sh --env-file config/nightly-usage.env --time 02:10
```

Install with pipeline dry-run mode:

```bash
bash scripts/install-nightly-usage-launchd.sh --env-file config/nightly-usage.env --time 02:10 --pipeline-dry-run
```

Check job status:

```bash
launchctl print gui/$(id -u)/com.invoker.usage-metrics
```

Force-run now:

```bash
launchctl kickstart -k gui/$(id -u)/com.invoker.usage-metrics
```

Uninstall:

```bash
bash scripts/uninstall-nightly-usage-launchd.sh
```

## Idempotency and Cardinality Guardrails

- Event-level dedupe uses stable `$insert_id` from `(report_date, family, stable row key)`.
- Stable keys avoid machine-path and ordering drift:
  - session/prompt events key by normalized `session_id` (file stem), not absolute paths
  - repeated-value cache-driver events key by `source + value_hash` (not list index)
- Sent IDs are persisted in `~/.invoker/usage-metrics/send_state.json` by default.
- Dry-runs do not mutate local state, so smoke tests cannot accidentally suppress live sends.
- For backfills or recovery from uncertain local state, use `--ignore-local-state` (or set `USAGE_PIPELINE_IGNORE_LOCAL_STATE=1`) and rely on deterministic `$insert_id` dedupe at Mixpanel.
- Prompt events include:
  - `prompt_hash` (SHA-256),
  - truncated `prompt_preview` (for debugging),
  - configurable unique hash cap per run/day.
- Per-family event volume can be capped with `MAX_EVENTS_PER_FAMILY`.

## Logs and Troubleshooting

Runner log file:

- `~/.invoker/usage-metrics/nightly-run.log` (or `USAGE_PIPELINE_LOG_DIR`)

Launchd logs:

- `~/.invoker/usage-metrics/launchd.stdout.log`
- `~/.invoker/usage-metrics/launchd.stderr.log`

Common issues:

- Missing env file: create `config/nightly-usage.env` from example.
- Missing Mixpanel token/auth: set required env vars.
- Missing report artifacts: run report generation manually or run full pipeline dry-run first.
- Too many events: reduce `MAX_EVENTS_PER_FAMILY` and/or `MAX_UNIQUE_PROMPT_HASHES_PER_DAY`.
