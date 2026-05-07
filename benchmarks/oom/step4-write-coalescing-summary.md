# Step 4 Write Coalescing Summary

Command:

```bash
REPRO_TIMEOUT_SEC=20 node scripts/run-oom-benchmark-matrix.mjs step4-write-coalescing
```

## Key Delta vs Step 3 (safe mode)

| metric | step3 | step4 | delta |
|---|---:|---:|---:|
| peak RSS (MB) | 564.0 | 584.0 | +20.0 |
| peak external (MB) | 490.3 | 495.9 | +5.6 |
| flush count | 102 | 105 | +3 |

## Notes

- Implemented timer coalescing in `scheduleFlush()` to avoid repeated timer resets during write bursts.
- Synthetic harness showed neutral-to-slightly-regressive memory deltas; we are retaining this change for now because it removes timer churn in the real adapter path and will be re-evaluated in later cumulative benchmarks.
