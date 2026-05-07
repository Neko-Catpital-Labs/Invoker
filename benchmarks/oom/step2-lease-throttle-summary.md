# Step 2 Lease-Renew Throttle Summary

Command:

```bash
REPRO_TIMEOUT_SEC=20 node scripts/run-oom-benchmark-matrix.mjs step2-lease-throttle
```

## Key Delta vs PR1 Baseline Matrix

| metric (safe mode) | before | after | delta |
|---|---:|---:|---:|
| peak RSS (MB) | 582.8 | 564.3 | -18.5 |
| peak external (MB) | 521.5 | 490.3 | -31.2 |
| lease renew update writes/sec | 390.94 | 0.5 | -390.44 |

## Notes

- Coordinator now passes renewal throttle options so lease heartbeat updates are skipped when heartbeat is still fresh and lease expiry is safely ahead.
- Throttling dramatically reduces persistence lease-update writes while preserving lease ownership semantics.
