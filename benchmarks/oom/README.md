# OOM Benchmark Artifacts

This directory stores OOM mitigation benchmark outputs.

Generated files:
- `*.json`: machine-readable metrics for PR summaries
- `*.md`: markdown summary table
- `*-safe.log`, `*-sandbox.log`: raw logs from each benchmark mode

Run baseline matrix:

```bash
node scripts/run-oom-benchmark-matrix.mjs baseline
```

Run a named matrix:

```bash
node scripts/run-oom-benchmark-matrix.mjs step-1-debounce
```
