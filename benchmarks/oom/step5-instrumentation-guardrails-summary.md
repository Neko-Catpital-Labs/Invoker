# Step 5 Instrumentation/Guardrails Summary

Command:

```bash
REPRO_TIMEOUT_SEC=20 node scripts/run-oom-benchmark-matrix.mjs step5-instrumentation-guardrails
```

## Key Delta vs Step 4 (safe mode)

| metric | step4 | step5 | delta |
|---|---:|---:|---:|
| peak RSS (MB) | 584.0 | 573.6 | -10.4 |
| peak external (MB) | 495.9 | 495.9 | 0.0 |
| flush count | 105 | 106 | +1 |

## Notes

- Added guardrail warnings on large/slow flush operations:
  - `INVOKER_SQLITE_FLUSH_WARN_THRESHOLD_MS` (default `250`)
  - `INVOKER_SQLITE_FLUSH_WARN_DB_MB` (default `256`)
  - `INVOKER_SQLITE_FLUSH_WARN_COOLDOWN_MS` (default `60000`)
- Benchmark overhead appears negligible in this synthetic run.
