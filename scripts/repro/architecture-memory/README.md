# architecture-as-memory paired coding evaluator

An offline A/B evaluator for one question: does *code structure* carry knowledge
forward to an agent that never saw the discussion that produced it?

Two trial snapshots are built from one immutable upstream commit. They differ by
a single documented structural delta. A fresh agent gets the same task prompt in
each, edits real code, and an external grader scores the resulting diff.

Nothing here touches the production execution path. It adds a measurement path
beside it.

## Status

This slice establishes that the apparatus executes and is checkable. One pair was
run: `records/pair-pilot-001.json`, `reports/pair-pilot-001.html`.

Both arms completed and both passed all seven grader checks. The pair therefore
separates nothing — this task was inside both arms' reach at `claude-opus-5`,
effort `high`. That is a result about the task, not a failure of the run, and it
is recorded as-is rather than retried with a tuned treatment.

The one qualitative observation worth keeping: the treatment agent found and used
`mutateTaskScoped` unprompted, while the baseline agent reproduced the same
lifecycle by hand. The structural delta is discoverable. Whether being
discoverable changes outcomes is exactly what one pair cannot tell you.

**One pair is not evidence that either architecture is better.**

## Commands

```bash
python3 scripts/repro/architecture-memory/run.py self-test
python3 scripts/repro/architecture-memory/run.py pilot
python3 scripts/repro/architecture-memory/run.py verify-recorded
python3 scripts/repro/architecture-memory/run.py report
python3 -m unittest discover -s scripts/repro/architecture-memory/tests -t scripts/repro/architecture-memory
```

`self-test` proves the apparatus and writes `records/controls-passed.json`.
`pilot` refuses to start without that stamp, and refuses again if the apparatus
changed since it was written. `verify-recorded` re-derives every recorded pair
from its committed artefacts and makes no model call. `report` regenerates the
HTML from those same records.

## The experiment

| | |
|---|---|
| Source commit | `0ca415e4d69a3f59a4b666e65f6362adf2d947ad` (canonical remote, independent of this branch's base) |
| Target file | `packages/app/src/workflow-mutation-facade.ts` |
| Baseline arm | that file, unmodified |
| Treatment arm | that file plus `treatment/structural-delta.patch` |
| Trial task | `task/PROMPT.md` — identical text in both arms |
| Grader | `grader/checks/close-idle-task.checks.test.ts` plus a typecheck and the upstream facade suite |

### The structural delta

`WorkflowMutationFacade` gives every task-scoped mutation the same lifecycle:
close the workflow's review, mutate, then dispatch the scoped launches and top up
scheduler capacity. In the baseline that lifecycle is a repeated three-line
convention in nine methods. The treatment routes those same nine through one
named helper, `mutateTaskScoped(taskId, context, mutate)`, which owns the order.

The delta is a pure refactor. `self-test` proves it: the upstream facade suite
(82 tests) and the repository typecheck pass identically in both snapshots, and
the two snapshots differ at exactly one file.

The delta is a **fixture**. It is applied to experimental copies only and is
never applied to the product tree in this repository.

### The trial task

Add `WorkflowMutationFacade.closeIdleTask(taskId)`, routing through
`CommandService.closeIdleTask` with the command id `facade.close-idle-task`, and
giving it "the same task-scoped lifecycle that every other task-scoped mutation
on this class already gets". The prompt never names the helper, never names
`closeReviewForTask`, and is byte-identical between arms.

The ownership invariant under test is *close the review before the mutation*.
The grader asserts it by call order on real mocks, not by looking for a helper
name in the diff.

## Grading

Grading happens in a clean evaluator copy that no trial agent ever sees, built
from the same archive and reset to a hash-verified pristine state before each
grade. Seven named checks, all exit codes preserved:

| check | asserts |
|---|---|
| `check:typecheck` | `tsc --noEmit -p tsconfig.typecheck.json` is clean |
| `check:existing-facade-suite` | the upstream facade and parity suites still pass |
| `check:exposes-close-idle-task` | the method exists and returns a `MutationResult` |
| `check:routes-through-command-service` | one `CommandService.closeIdleTask` call with the right envelope |
| `check:closes-review-before-mutation` | **ownership invariant**: review closed *before* the mutation |
| `check:runs-scoped-dispatch-and-topup` | global top-up ran and its launches are returned |
| `check:propagates-command-service-failure` | a failed `CommandResult` rejects |

`self-test` runs six controls per variant and requires each to land exactly where
it should: the unedited snapshot fails, a no-op fails, a stub fails, a patch that
skips the review close fails *only* `check:closes-review-before-mutation`, a patch
with the wrong envelope fails *only* `check:routes-through-command-service`, and
the gold patch passes everything. In both variants.

## Isolation

Grader checks, gold patches, control patches, pristine snapshots and recorded
results are all unreadable from inside a trial. The mechanism is a macOS Seatbelt
profile (`sandbox-exec`) denying reads and writes to the repository checkout, the
run directory, and `~/.invoker`; trial workspaces live outside all three. The
trial workspace is also stripped of every prose channel that could carry the
knowledge instead of the code — `CLAUDE.md`, `ARCHITECTURE.md`, `docs/`,
`skills/`, `.cursor/`, `plans/` and the rest of `TRIAL_WORKSPACE_REDACTIONS` —
and is a fresh single-commit git repository with no history.

Denial is asserted, not assumed: `self-test` probes each protected path through
the same wrapper and fails if any read or write succeeds. If no supported
isolation mechanism is available the run emits blocked evidence and starts no
trial rather than substituting a weaker benchmark.

Cross-session memory is closed at the same layer. Redirecting `CLAUDE_CONFIG_DIR`
also drops the operator's credentials, so `~/.claude/CLAUDE.md`, `projects/`,
`sessions/`, `plugins/`, `skills/`, `hooks/`, `~/.cursor` and `~/.codex` are denied
by the profile instead, while user settings, plugins, MCP servers and the saved
model are dropped with `--setting-sources ""`, `--strict-mcp-config`,
`--disable-slash-commands` and explicit `--model`/`--effort` pins.

Trials may edit and test locally. Publication is denied by tool rules
(`WebFetch`, `WebSearch`, `Bash(git push:*)`, `Bash(gh:*)`, `Bash(curl:*)` and
friends). `bypassPermissions` is never used.

## Budget discipline

- One attempt per arm per pair. `records/attempt-ledger.json` is written *before*
  the harness starts, so a crashed or retried Invoker task cannot buy more trials.
- No automatic retries. A timeout, a crash or a refusal is that trial's outcome.
- Setup failures are a distinct status from coding failures.
- An unsuccessful agent result is valid data. It is not a reason to tune the
  treatment and rerun; doing so would invalidate the pair.

## Cost accounting

Native per-trial telemetry only. When a registered harness reports no dollar
cost, the record says so and `dollar_conclusion_permitted` is `false`; token
totals are never reported as dollars. Apparatus development and setup cost —
including the throwaway calls used to validate harness flags — is not a measured
trial cost and is not mixed into one.

## Adding a harness

Register it in `runners.json` with its binary, version probe, pinned model and
effort, argv template, isolation flags and `cost_telemetry`. Select it with
`--runner`. Both arms always get one resolved configuration; `pilot` compares the
two arm configurations field by field and refuses to start if they differ.

`codex` is registered and unused. Its isolation is *not* proven by the committed
controls — only the harness actually selected for a pair is.

## Relationship to `scripts/run_skill_evals.py`

That harness is the right tool for response quality: paired baseline/candidate
prompts, a weighted rubric, human or model judging, resumable runs. Its runners
invoke `--tools ""` deliberately, because it judges *stated decisions*.

Reused here, in shape rather than in code: paired conditions over one identical
prompt, registered runners that strip operator configuration and pin the model,
a resumable/idempotent record of completed work, and an explicit refusal to
publish numbers from unmetered runs.

The gap that needed a new mode: this experiment's dependent variable is *edited
code*, so a trial has to execute file edits and test commands, and scoring has to
run those tests in a copy the agent could not touch. A tool-disabled prompt
evaluation cannot produce that evidence, and making `run_skill_evals.py` execute
real edits would change what its existing cases mean. The two live side by side.

## Layout

```
run.py                       self-test | pilot | verify-recorded | report
runners.json                 registered harnesses, pinned values, isolation flags
amlib/manifest.py            source commit, structural delta, redactions, check ids
amlib/{snapshots,isolation,grading,trials,ledger,records,report,verify}.py
task/PROMPT.md               the trial prompt, identical in both arms
treatment/structural-delta.patch
grader/checks/               evaluator-owned behavioural checks
grader/patches/{baseline,treatment}/   gold and control patches
tools/build_fixture_patches.py         regenerates every patch above
records/                     controls stamp, attempt ledger, pair records, replay patches
reports/                     self-contained HTML
tests/                       focused unit tests, no model calls
```

Raw harness output stays in the run directory outside the repository and is never
committed. Records carry a hash of it, not the text.

## Next protocol (described, not launched)

Six behavioural tasks by five repeats per arm — 60 trials — same apparatus, same
pinned configuration, per-task randomized order, control matrices rerun before
each batch, and per-task grader check sets built the same way. Deliberately not
started here. The apparatus has to be trustworthy first, and after one pair it is
only demonstrated, not characterised.
