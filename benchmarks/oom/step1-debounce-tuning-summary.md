# Step 1 Debounce Tuning Summary

Sweep command:

```bash
for d in 250 1000 3000 5000; do \
  INVOKER_SQLITE_FLUSH_DEBOUNCE_MS=$d \
  REPRO_FLUSH_DEBOUNCE_MS=$d \
  REPRO_TIMEOUT_SEC=15 \
  node scripts/run-oom-benchmark-matrix.mjs "step1-debounce-${d}ms"; \
done
```

## Results Snapshot

| debounce (ms) | safe peak RSS (MB) | safe flush count | safe db growth (MB/min) | sandbox peak RSS (MB) |
|---:|---:|---:|---:|---:|
| 250 | 477.6 | 56 | 342.41 | 507.4 |
| 1000 | 874.6 | 10 | 1658.60 | 515.0 |
| 3000 | 884.8 | 6 | 2253.27 | 505.0 |
| 5000 | 885.5 | 6 | 2276.77 | 519.1 |

## Decision

- Keep owner default debounce at `250ms` for now.
- In this workload, larger debounce values reduced flush count but caused much larger flush payloads and significantly higher memory/growth pressure in `safe` mode.
- We still keep debounce externally configurable via `INVOKER_SQLITE_FLUSH_DEBOUNCE_MS` for site-specific tuning.
