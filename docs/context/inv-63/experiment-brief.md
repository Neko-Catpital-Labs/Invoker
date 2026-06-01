# INV-63 Experiment Brief

## Goal
Establish deterministic, replayable proof that the plan-to-invoker
skill's benchmark/direct-output contract behaves as documented across
the canonical SKILL.md, the Cursor-installed mirror, and the
deterministic skill-doctor script. The artifact this brief produces is
the experiment evidence referenced by INV-63 reviewers.

## Motivation
Architecture decisions for INV-63 (the direct-output benchmark
contract) must be evidence-backed. Without a written, command-level
experiment, the decision to keep the contract anchored in SKILL.md
(instead of moving it into a generated wrapper script) is unauditable.

## Files under test
- `skills/plan-to-invoker/SKILL.md`
- `.cursor/skills/plan-to-invoker/SKILL.md`
- `skills/plan-to-invoker/scripts/skill-doctor.sh`

## Alternative considerations
Two designs were compared:

1. **Selected: Anchor the contract in
   `skills/plan-to-invoker/SKILL.md` and mirror it into
   `.cursor/skills/plan-to-invoker/SKILL.md`, with `skill-doctor.sh`
   enforcing structural checks.** Pros: single source of truth,
   grep-friendly contract text, Cursor and Claude surfaces stay
   byte-identical, doctor failures are deterministic. Cons: requires
   the install script to keep mirrors in sync.

2. **Rejected: Generate the contract from a templated wrapper script
   that emits SKILL.md at install time.** Pros: lower duplication.
   Cons: contract text disappears from `git grep`; reviewers cannot
   read the rule without running the generator; doctor checks become
   harder because the source of truth is no longer the rendered file.

The selected design wins on reviewability and on the deterministic
doctor-check surface, which is the primary INV-63 acceptance gate.

## Deterministic commands

| # | Command | What it proves |
|---|---------|----------------|
| 1 | `test -f skills/plan-to-invoker/SKILL.md` | Canonical skill file is present. |
| 2 | `grep -qF 'Benchmark/direct-output mode' skills/plan-to-invoker/SKILL.md` | Contract heading is anchored. |
| 3 | `grep -qF 'Treat the literal absolute output path' skills/plan-to-invoker/SKILL.md` | Literal-path rule (the load-bearing INV-63 sentence) is anchored. |
| 4 | `test -f .cursor/skills/plan-to-invoker/SKILL.md` | Cursor mirror is present. |
| 5 | `grep -qF 'plan-to-invoker' .cursor/skills/plan-to-invoker/SKILL.md` | Cursor mirror identifies as the same skill. |
| 6 | `test -x skills/plan-to-invoker/scripts/skill-doctor.sh` | Doctor script is executable. |
| 7 | `grep -qE 'Usage:\|--help' skills/plan-to-invoker/scripts/skill-doctor.sh` | Doctor exposes a usage/help surface for deterministic invocation. |

## Expected outputs
Each command above exits with status `0` and produces no stderr on
the selected design. Any non-zero exit is a verdict-flipping signal:
the design assumption (contract anchored in the canonical SKILL.md
and mirrored to Cursor, with a deterministic doctor) no longer
holds.

## Verdicts
- **PASS** — All 7 commands exit `0`. The selected design is
  empirically in force in the current checkout; INV-63 reviewers may
  accept the architecture choice on this evidence.
- **FAIL** — Any command exits non-zero. The selected design is not
  in force; reviewers must reopen the architecture decision (and
  consider the rejected templated-wrapper alternative or another
  design).

## Thresholds
- Pass-rate threshold: **7/7** commands must exit `0`. There is no
  partial-credit threshold; every command tests a load-bearing
  invariant of the selected design.
- Latency threshold: each command must complete within **5 seconds**
  on the benchmark host. Slower execution indicates filesystem or
  sandbox interference and invalidates the run rather than the
  design.
- Determinism threshold: re-running the full suite twice in
  succession must produce identical exit codes and identical
  stdout/stderr byte streams (modulo timestamps the commands do not
  emit). Any divergence invalidates the run.
