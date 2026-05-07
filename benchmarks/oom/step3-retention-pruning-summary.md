# Step 3 Retention/Pruning Summary

Command:

```bash
REPRO_TIMEOUT_SEC=20 node scripts/run-oom-benchmark-matrix.mjs step3-retention-pruning
```

## Key Delta vs Step 2 (safe mode)

| metric | step2 | step3 | delta |
|---|---:|---:|---:|
| peak RSS (MB) | 564.3 | 564.0 | -0.3 |
| peak external (MB) | 490.3 | 490.3 | 0.0 |
| db growth (MB/min) | 385.63 | 382.63 | -3.0 |

## Notes

- Added periodic retention pruning to cap completed mutation intents and output spool growth in owner mode.
- Pruning is controlled by:
  - `INVOKER_RETENTION_PRUNE_INTERVAL_MS` (default `300000`)
  - `INVOKER_RETENTION_MAX_COMPLETED_INTENTS` (default `20000`)
  - `INVOKER_RETENTION_MAX_OUTPUT_ROWS` (default `300000`)
