# Migration Gate Evaluation (Phase 2 Trigger)

## Inputs

- PR0 baseline: `benchmarks/oom/2026-05-07T18-49-32-283Z-baseline.json`
- PR1 sweep (selected 250ms): `benchmarks/oom/2026-05-07T18-54-58-695Z-step1-debounce-250ms.json`
- PR2: `benchmarks/oom/2026-05-07T19-03-39-767Z-step2-lease-throttle.json`
- PR3: `benchmarks/oom/2026-05-07T19-07-22-216Z-step3-retention-pruning.json`
- PR4: `benchmarks/oom/2026-05-07T19-09-26-508Z-step4-write-coalescing.json`
- PR5: `benchmarks/oom/2026-05-07T19-11-45-046Z-step5-instrumentation-guardrails.json`

## Safe-Mode Trend (selected points)

| phase | timeout window (s) | peak RSS (MB) | peak external (MB) | flush count | db growth (MB/min) |
|---|---:|---:|---:|---:|---:|
| baseline | 20 | 582.8 | 521.5 | 104 | 383.94 |
| step1 (250ms) | 15 | 477.6 | 395.5 | 56 | 342.41 |
| step2 | 20 | 564.3 | 490.3 | 103 | 385.63 |
| step3 | 20 | 564.0 | 490.3 | 102 | 382.63 |
| step4 | 20 | 584.0 | 495.9 | 105 | 386.06 |
| step5 | 20 | 573.6 | 495.9 | 106 | 382.29 |

## Threshold Evaluation

- No OOM in target stress windows: **partial pass** (timeouts hit first in harness, but memory still very high).
- Peak memory below safety margin: **fail** (safe-mode peak RSS still ~560-585MB).
- DB growth bounded/predictable: **fail** (still ~380MB/min).
- No correctness regressions: **pass** (test suites green in each phase).

## Decision

- **Trigger Phase 2 migration work** (non-`db.export()` persistence path) because phase-1 optimizations did not reduce steady-state growth or memory pressure enough.
- This stack records the gate decision and preparation artifacts; migration implementation should proceed as a dedicated follow-up stack to minimize risk.
