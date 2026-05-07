# OOM Benchmark Matrix: step5-instrumentation-guardrails

- Commit: `0318846b10696817ab1a8b2f18bff6f502c67067`
- Generated: 2026-05-07T19:12:25.969Z

| mode | status | time-to-failure/completion (s) | peak RSS (MB) | peak external (MB) | flush count | mean flush interval (ms) | db growth (MB/min) | lease renew update writes/sec | mutation throughput (intents/sec) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| safe | failed | 20.28 | 573.6 | 495.9 | 106 | 187.24 | 382.29 | 0.49 | 118.35 |
| sandbox | failed | 20.21 | 550.3 | 479.3 | 108 | 180.86 | 287.13 | 0.49 | 89.08 |

## Failure Reasons

- safe: timeout guard reached (20s) before OOM
- sandbox: timeout guard reached (20s) before OOM

