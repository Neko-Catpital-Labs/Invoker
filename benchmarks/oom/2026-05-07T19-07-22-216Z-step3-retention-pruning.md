# OOM Benchmark Matrix: step3-retention-pruning

- Commit: `8b62311aa6b5f971f6f04a5918595408120637c2`
- Generated: 2026-05-07T19:08:03.153Z

| mode | status | time-to-failure/completion (s) | peak RSS (MB) | peak external (MB) | flush count | mean flush interval (ms) | db growth (MB/min) | lease renew update writes/sec | mutation throughput (intents/sec) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| safe | failed | 20.26 | 564 | 490.3 | 102 | 194.07 | 382.63 | 0.49 | 118.46 |
| sandbox | failed | 20.21 | 549.2 | 479.3 | 107 | 182.77 | 287.03 | 0.49 | 89.05 |

## Failure Reasons

- safe: timeout guard reached (20s) before OOM
- sandbox: timeout guard reached (20s) before OOM

