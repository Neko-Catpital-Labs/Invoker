# Getting Started

This is the short operational path for running Invoker and understanding the review-gate CI repair controls.

## Local Setup

```bash
git clone <repository-url> invoker
cd invoker
pnpm install
bash scripts/setup-agent-skills.sh
pnpm run build
./run.sh
```

Use the headless surface for scripted runs:

```bash
./run.sh --headless --help
./run.sh --headless run /path/to/plan.yaml
./run.sh --headless query workflows
```

Invoker reads user config from `~/.invoker/config.json`. For a repo-specific config, launch with:

```bash
INVOKER_REPO_CONFIG_PATH=$PWD/.invoker.local.json ./run.sh
```

## Minimal Config

```json
{
  "maxConcurrency": 6,
  "autoFixRetries": 2,
  "autoApproveAIFixes": false,
  "autoFixAgent": "codex"
}
```

`autoFixRetries`, `autoApproveAIFixes`, and `autoFixAgent` are user config fields. They are not plan fields. Plan YAML using `autoFix` or `autoFixRetries` is rejected.

## Review-Gated Plans

Use the existing review-gate fields when a workflow should finish through a pull request:

```yaml
name: review-gated-ci-example
repoUrl: git@github.com:your-org/your-repo.git
baseBranch: main
onFinish: pull_request
mergeMode: external_review
tasks:
  - id: tests
    description: Run tests
    command: pnpm test
    dependencies: []
```

The review gate must be workflow-mapped: Invoker has to own the merge task and persist the PR artifact on that task. `repair-review-gate-ci` is not for arbitrary PRs that were created outside the workflow.

## CI Repair Operations

For workflow-mapped review gates, the built-in `ci-failure` worker owns automatic CI repair queueing. It consumes live `review_gate.ci_failed` events and also runs the persisted PR CI failure scan (`pr-ci-failure-scan`, logged as `worker-ci-failure-scan-*`) so a missed event can be recovered from stored review-gate artifacts.

The manual command uses the same queueing policy:

```bash
./run.sh --headless query review-gate-ci 123 --output json
./run.sh --headless repair-review-gate-ci 123
./run.sh --headless repair-review-gate-ci https://github.com/your-org/your-repo/pull/123
```

`query review-gate-ci` inspects the mapping and any existing `ci-failure` action. `repair-review-gate-ci` maps the PR target back to exactly one Invoker merge-gate task and queues a `fix-with-agent` mutation recorded under the `ci-failure` worker with action type `fix-ci-failure`.

Queueing requires:

- `autoFixRetries` is greater than `0` and the retry budget is not exhausted.
- The owning Invoker process can submit workflow mutations.
- The configured `autoFixAgent` is installed; if unset, the built-in default fix agent is used.
- Provider access is available when Invoker needs to create, poll, or refresh the review-gate artifact. For GitHub review gates, that means authenticated `gh` access in the owner environment.
- The merge task is `review_ready` or `awaiting_approval`.
- The current review artifact is required, open, on the active generation, has `checksState: failure`, and includes `failedChecks`.
- The gate is not a merge conflict. `mergeState: dirty` is skipped by CI repair and belongs to conflict resolution.

After the agent applies a fix, `autoApproveAIFixes` controls whether Invoker approves the local fix automatically. It does not approve or merge the external PR.
