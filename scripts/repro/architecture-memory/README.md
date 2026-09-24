# Architecture-as-memory: paired real-edit coding evaluator

Offline proof tooling. It asks one question for one task: when a coding agent starts with no prior
context, does a structural change to the code (the "architecture as memory") change the code the
agent writes? It measures the resulting code with external checks, not the agent's prose.

Nothing here touches product packages, installed skills, the workflow runtime, or live Invoker state.
All experimental edits happen in throwaway copies under `/private/tmp/archmem/`.

```bash
python3 scripts/repro/architecture-memory/run.py self-test        # deterministic checks, no model calls
python3 scripts/repro/architecture-memory/run.py pilot            # exactly one real A/B pair (refuses a second run)
python3 scripts/repro/architecture-memory/run.py verify-recorded  # regrade committed patches, no model calls
```

## Experimental design

| Piece | Where | Notes |
| --- | --- | --- |
| Source | `manifest.json` → `source` | Commit `0ca415e4d69a…` from the canonical remote, pinned by tree hash. Both arms are `git archive` copies of this one commit, not two releases. |
| Structural delta (treatment only) | `fixture/treatment-structural-delta.patch` | Extracts `WorkflowMutationFacade.runTaskCommand` (close workflow review → CommandService → dispatch scoped to the task) and routes `retryTask`/`recreateTask` through it. Frozen before the task was written. Applied only to experimental copies. |
| Behavior-preservation gate | `regression_tests` in the manifest | The three existing facade/API test files (172 tests) must pass with identical per-test outcomes in both unpatched arms before any trial. |
| Task | `task/prompt.md` | Add `WorkflowMutationFacade.editTaskPool(taskId, poolId)`. Today `editTaskPool` is only reachable by calling `CommandService` directly (headless, IPC, main). Same prompt byte for byte in both arms. Needs a real code edit. |
| Hidden grader | `grader/hidden-edit-task-pool.test.ts` | Six behavioral vitest checks, copied into the graded copy only after the trial: method exists; the mutation goes through `CommandService.editTaskPool` exactly once with the right payload and task scope (the ownership invariant); the workflow review closes before the mutation; only the edited task is mutation-scoped `runnable` and the rest goes to topup; error mapping; no topup after a failure. It never checks for a helper name. The existing facade/API suites must still pass too. |
| Controls | `controls/<arm>/*.patch` | Written by `author_controls.py` and pinned by hash. In each arm: the unedited snapshot, a no-op (adds only a todo test), and four wrong patches (stub, bypass CommandService, skip review close, unscoped dispatch) must fail. The gold patch must pass. |

### Isolation (trial agents cannot read grading answers)

Each trial runs under macOS `sandbox-exec` with a profile generated per trial (`isolation_plan` / `sandbox_profile`).
- **Read/write denied:** the evaluator checkout (grader, gold patches, manifest), the other arm's copy, the evaluator private copies, the ledger/raw-session state dir, `~/.claude`, `~/.codex`, `~/.invoker` (live state, worktrees, repos), `~/.ssh`, `~/.config/gh`, and the harness config dir's `projects/`, `history.jsonl`, `skills/`, `plugins/`, `CLAUDE.md`, and similar paths.
- **Exec denied:** `gh`, `invoker-cli`, `invoker-ui`, and git credential helpers.
- **What the trial sees:** a snapshot with no git remote and no history, just one `snapshot` commit.

The access-denial controls run the same profile against real probes and require each one to be denied. They also check that the trial can still read and write its own copy and run `node`.

Harness isolation uses only documented CLI controls: `--setting-sources ""`, `--strict-mcp-config`, `--disable-slash-commands`, `--no-session-persistence`, `--settings {"autoMemoryEnabled":false,"disableAllHooks":true}`, and `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`. Permissions are `--permission-mode acceptEdits` plus a Bash allowlist for tests, read-only git, and file inspection. It never bypasses permissions.

The harness authenticates through its existing config dir (`ARCHMEM_CLAUDE_CONFIG_DIR`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`). Only that dir's non-session files are re-allowed.

Known gap: network egress is allowed because the harness needs its API. Publication is blocked by removing git remotes, denying credential helpers and CLIs, and the Bash allowlist, not by a firewall.

### Runner registry

`runners.json` registers harnesses (`claude`, `codex`) and a `selection` block (harness, model, effort, budget, timeout).
- **Pinning:** before any call, `resolve_harness` records the binary realpath, its sha256, and its `--version` output.
- **Config equality:** each arm's full config (argv, env, isolation plan with the trial path normalized, prompt hash, grader hash) is hashed, and the two hashes must be equal.
- **Scope of this pair:** only the selected harness runs. `codex` is registered but was not exercised.

### Idempotent attempt ledger

`~/.local/state/invoker-archmem/<experiment>/<pair>/ledger.jsonl` lives outside the repo and outside Invoker state.
- **Write order:** `trial_start` is fsynced before the harness starts. `trial_end`, `setup_failed`, and `graded` follow.
- **Re-running:** a second `pilot` for the same pair id is refused. With `--resume`, a started-but-unfinished arm is recorded as `abandoned_partial` and never re-invoked, so a retried Invoker task cannot buy more trials.
- **Retries:** there are no automatic retries.
- **Failure types:** setup failures (`setup_failed`) are kept separate from coding outcomes (`completed` / `agent_error` / `timed_out`).

### Recorded evidence

`records/<pair>/` holds:
- `pair.json`: sanitized record with pins, configs, preflight gates, per-arm telemetry, all check exits and per-test statuses, and the cost summary.
- `ledger.jsonl`
- `patches/<arm>.patch`: the exact captured diffs.
- `report.html`: self-contained report.

Raw harness streams stay in the state dir and are never committed. `verify-recorded` does the following without calling a model:
- rechecks the pinned-input hashes
- refetches the source and rebuilds both snapshots to the recorded trees
- validates pair completeness, config equality, and single invocations
- reapplies each captured patch in a fresh copy and regrades it with the hidden checks
- requires identical per-check statuses

## Reuse of existing eval tooling

`scripts/run_skill_evals.py` is a response-quality harness. It runs with `--tools ""` from the repo root, retries failed calls, and uses human rubric scoring (see `evals/plan-to-invoker/README.md`). This evaluator reuses its `parse_response` (claude-json cost and usage parsing, codex-jsonl parsing) and its runner-registry and isolation-flag conventions. It does not change that mode.

That harness can't do the following, so real-edit trials need a separate path:
- run tools in an isolated editable copy
- deny grader access at the OS level
- grade a diff with behavioral checks
- refuse retries

## Development and setup costs (not trial costs)

While authoring, two throwaway `claude-haiku-4-5` smoke calls checked that the harness authenticates and runs under the sandbox. The CLI reported $0.017 and $0.0125. The authoring session's own cost isn't measured by this tool. None of these count toward the pair.

## Limits

- **One pair:** it shows the apparatus runs end to end. It is not a statistically supported architecture effect.
- **Dollars:** these are the harness's own client-side estimate. No prices are invented, and there is no dollar-efficiency conclusion.
- **Typecheck:** there is none, because the source commit has no working per-package `tsc` entry point. Grading is behavioral (vitest) only.
- **Later protocol, not launched:** six frozen tasks × five paired repeats, with a pre-registered primary metric.
