# Invoker Benchmark Nightly Launcher

The benchmark harness lives in `invoker-benchmarks/` and is intended to be
installed on the coordinator at:

```text
/home/invoker/invoker-benchmarks/
```

Cron should invoke only:

```bash
/home/invoker/invoker-benchmarks/bin/run-nightly-benchmark.sh
```

Default schedule:

```cron
0 0 * * * TZ=Asia/Hong_Kong /home/invoker/invoker-benchmarks/bin/run-nightly-benchmark.sh
```

## Install

1. Copy `invoker-benchmarks/` to `/home/invoker/invoker-benchmarks/` on
   `remote_digital_ocean_1`.
2. Copy `config/benchmark.env.example` to `config/benchmark.env` and fill in
   Mixpanel auth if live emission is desired.
3. Generate worker inventory from the coordinator Invoker config:

```bash
/home/invoker/invoker-benchmarks/bin/sync-worker-credentials.sh \
  --write-workers /home/invoker/invoker-benchmarks/config/workers.json
```

The generated worker list includes `remote_digital_ocean_2`,
`remote_digital_ocean_3`, `remote_digital_ocean_4`, and `remote_linode_1`.
The coordinator only orchestrates and does not run benchmark jobs.

## Validation

```bash
/home/invoker/invoker-benchmarks/bin/run-nightly-benchmark.sh --dry-run
/home/invoker/invoker-benchmarks/bin/run-nightly-benchmark.sh --smoke
/home/invoker/invoker-benchmarks/bin/run-nightly-benchmark.sh --limit 6
```

No-argument nightly runs publish metrics by default. Add `--no-emit-mixpanel`
to write `mixpanel-export.jsonl` locally without publishing. Smoke runs publish
only when `--emit-mixpanel` is passed.

## Runtime Output

Each batch writes to:

```text
/home/invoker/invoker-benchmarks/runs/YYYY-MM-DD_HH-mm-ss_HKT_<batch_id>/
```

The coordinator writes `summary.md`, `summary.json`, `job-matrix.tsv`,
`worker-assignments.tsv`, and `mixpanel-export.jsonl`. Each job writes
`job.json`, logs, generated plan, token usage, raw sessions, and the disposable
checkout under `jobs/<run_id>/`.
