# Real trials purchased by earlier attempts of this Invoker task

The Invoker task `wf-1789538353357-260/build-and-run-paired-pilot` has been regenerated several
times. Each attempt got a fresh worktree, and three of them ran their own real A/B pair with their
own apparatus and their own task. Every one of those trials counts as a real trial outcome, so they
are listed here rather than dropped.

| Attempt branch (suffix) | Date (UTC) | Experiment task | Harness / model / effort | Baseline | Treatment | Record |
| --- | --- | --- | --- | --- | --- | --- |
| `g0.t1.a-abbac3a69` | 2026-09-16 | retry-qualified-task-review-close | codex / gpt-reserve / low | empty patch, hidden checks failed (1 of 2) | empty patch, hidden checks failed (1 of 2) | `records/pilot-record.json` on that branch |
| `g1.t13.a-a40f8a775` | 2026-09-22 | close-idle-task | claude | passed | passed | `records/pair-pilot-001.json` on that branch |
| `g2.t14.a-a257cf03b` | 2026-09-24 | facade-edit-task-pool | claude / claude-sonnet-5 / medium | passed | passed | `records/pilot-001/` (this directory) |

Branches `g1.t2`, `g1.t9` (three attempts) and `g1.t10` contain no trial records.

## What this attempt (`g3.t15.a-a7fec8d51`) did

It ran no new trial. `g2.t14` had already committed a complete apparatus that satisfies this
protocol: OS-level grader isolation, an idempotent ledger at
`~/.local/state/invoker-archmem/architecture-memory-edit-task-pool-v1/pilot-001/ledger.jsonl`,
and one recorded pair. A fourth pair from a retried task is exactly what that ledger exists to
prevent. So this attempt cherry-picked `g2.t14`'s two commits unchanged, then re-ran `self-test`
and `verify-recorded` independently. It also ran `pilot`, which refused as designed. Those outputs
are in `g3-*-output.txt`.

Before it found `g2.t14`, this attempt had started drafting a separate evaluator (a `replaceTask`
task). It made no model calls for that draft beyond about seven `claude-haiku-4-5` sandbox smoke probes
(each CLI-reported below $0.01; the exact total was not captured). That is development cost, not
trial cost. It discarded the draft
uncommitted. It read the `g2.t14` ledger outcome only after that draft's structural delta had
already been written, so nothing in the recorded pair was tuned from those results.

## How to read the set

The pairs used different tasks, graders, harnesses, and treatments. They are not repeats of one
experiment and must not be pooled. The only pair this directory's `verify-recorded` vouches for
is `pilot-001` (edit-task-pool).

## What attempt `g4.t16.a-a6490ed2f` did

It ran no new trial and wrote no new evaluator code. It cherry-picked `g3.t15`'s three commits
unchanged onto base `2107253a6`, then re-ran `self-test` (68 passed, 0 failed), `verify-recorded`
(OK, exit 0), and `pilot` (refused, exit 2). The `pilot-001` ledger still has 8 events, the same as
before this attempt. The outputs are in `g4-*-output.txt`. This attempt made no model calls.

## What attempts `g5.t17.a-aa730476c` and `g5.t19.a-a89da2560` did

`g5.t17` committed only an empty failed-task marker (exit 1). It has no apparatus and no ledger
events. `g5.t19` ran no new trial and wrote no new evaluator code. It cherry-picked `g4.t16`'s
commits unchanged onto base `1b7ddfbbb` and re-ran the same three commands. The results were
`self-test` (68 passed, 0 failed), `verify-recorded` (OK, exit 0), and `pilot` (refused, exit 2).
The `pilot-001` ledger still has 8 events. The self-test config hash differs from g4's because the
installed harness CLI moved from 2.1.282 to 2.1.283. That self-test pins whatever CLI is installed
now. The recorded pair keeps its own pinned configuration, which `verify-recorded` checks. The
outputs are in `g5-*-output.txt`. This attempt made no model calls.
