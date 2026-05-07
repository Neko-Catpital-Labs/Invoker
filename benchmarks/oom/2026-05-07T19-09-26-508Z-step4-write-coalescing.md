# OOM Benchmark Matrix: step4-write-coalescing

- Commit: `b5b9cbf481665dbc41da083ef6191a5ba352a5ce`
- Generated: 2026-05-07T19:10:07.270Z

| mode | status | time-to-failure/completion (s) | peak RSS (MB) | peak external (MB) | flush count | mean flush interval (ms) | db growth (MB/min) | lease renew update writes/sec | mutation throughput (intents/sec) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| safe | failed | 20.08 | 584 | 495.9 | 105 | 187.12 | 386.06 | 0.5 | 119.52 |
| sandbox | failed | 20.23 | 557.4 | 487.4 | 110 | 177.8 | 286.83 | 0.49 | 88.99 |

## Failure Reasons

- safe: timeout guard reached (20s) before OOM
- sandbox: timeout guard reached (20s) before OOM

