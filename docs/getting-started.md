# Getting Started

## Start Invoker

Invoker reads user config from `~/.invoker/config.json`. For a repo-specific config, launch with:

```bash
INVOKER_REPO_CONFIG_PATH=$PWD/.invoker.local.json ./run.sh
```

Start the desktop app with:

```bash
./run.sh
```

Use the headless surface for scripted operations:

```bash
./run.sh --headless --help
./run.sh --headless run /path/to/plan.yaml
./run.sh --headless query workflows
```

Mutating headless commands are owner-routed. If the desktop app already owns the workflow database, the command delegates the mutation to that owner instead of writing state independently.

## Review-Gate CI Repair

CI repair for review gates applies only to workflow-mapped external review gates. The review gate must be current, open, required, in the active generation, and failing CI with at least one failed check. Dirty merge state is not handled by this path; a `mergeState: dirty` gate is reported as `merge-conflict`.

Enable repair by setting a positive retry budget:

```json
{
  "autoFixRetries": 3,
  "autoFixAgent": "claude"
}
```

`autoFixRetries` and `autoFixAgent` are config keys, not plan fields. Do not put `autoFix`, `autoFixRetries`, or CI-repair settings in plan YAML.

Enablement assumptions:

- `autoFixRetries` is greater than `0`.
- The workflow owner is running and can submit workflow mutation intents.
- The review-gate status path has persisted the PR/check artifact on the merge node.
- The selected fix agent is installed in the workspace where the fix mutation runs.

The ownership split is:

- `ci-failure` is the built-in automatic worker. It consumes `review_gate.ci_failed` events and scans persisted review-gate artifacts, then queues `invoker:fix-with-agent` when the mapped task is repairable and still has retry budget.
- `repair-review-gate-ci` is the manual headless mutation. It accepts a PR number or PR URL, resolves it to exactly one workflow-mapped review gate, and queues the same repair path as the worker.
- `query review-gate-ci` is read-only inspection for the same mapping and skip reasons.
- `pr-ci-failure-scan` is an operator scan/discovery step. It can identify candidate PRs, but Invoker-owned repair should still go through `query review-gate-ci` or `repair-review-gate-ci`; the scan should not create plan fields or run an independent fixer.

Operational sequence:

```bash
./run.sh --headless query review-gate-ci 123 --output json
./run.sh --headless repair-review-gate-ci 123
./run.sh --headless query review-gate-ci 123
```

Expected skip reasons are concrete: unmapped PRs report `no-workflow-review-gate`, non-failing checks report `ci-not-failing`, dirty PRs report `merge-conflict`, stale artifacts report lineage/status reasons, and exhausted budgets report retry-budget reasons.
