# OOM Benchmark Matrix: step2-lease-throttle

- Commit: `f666d98b6e56cd9ecbf8f7a1d679d2a17f546378`
- Generated: 2026-05-07T19:04:20.415Z

| mode | status | time-to-failure/completion (s) | peak RSS (MB) | peak external (MB) | flush count | mean flush interval (ms) | db growth (MB/min) | lease renew update writes/sec | mutation throughput (intents/sec) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| safe | failed | 20.1 | 564.3 | 490.3 | 103 | 190.68 | 385.63 | 0.5 | 119.39 |
| sandbox | failed | 20.08 | 545.1 | 471.3 | 103 | 188.26 | 288.99 | 0.5 | 89.65 |

## Failure Reasons

- safe: timeout guard reached (20s) before OOM
- sandbox: timeout guard reached (20s) before OOM

