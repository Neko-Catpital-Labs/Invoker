---
name: make-pr
description: >
  Create or update a pull request in this repo using the preferred PR schema,
  upstream-first branch workflow, and repo-specific publication rules. Trigger
  when asked to make a PR, update a PR body, prepare PR text, or publish a
  stacked PR branch.
---

# make-pr

Use this skill when the work is already done and the user wants a PR created, updated, or rewritten.

## What this skill covers

- PR title/body authoring for Invoker
- The preferred PR section schema
- Upstream-first branch/PR workflow (explicit base and publish remotes)
- Publication strategy awareness:
  - `github_pr` (default): standard GitHub PR via `GitHubMergeGateProvider` — used for all repos unless they opt into Mergify Stacks
  - `mergify_stack` (explicit opt-in): stacked PR publication via `MergifyStackProvider` — use `mergify stack push` for Invoker-on-Invoker or repos that independently adopt Mergify Stacks

## Preferred PR schema

Default to this structure:

```md
## Summary

Short explanation of what changed and why.

## Architecture

Only include this section when the change modifies component interactions, control flow, state flow, or data flow.

### Before

```mermaid
...
```

### After

```mermaid
...
```

## Test Plan

- [ ] exact command
- [ ] exact command

## Revert Plan

- Safe to revert? Yes/No
- Revert command: `git revert <sha>` or equivalent
- Post-revert steps: None / concrete steps
- Data migration? No / concrete steps
```

If the change is small and has no architectural impact, omit `## Architecture` rather than forcing filler.

Do not default to a lightweight `## Summary / ## Testing / ## Notes` PR body. That shape is ad hoc drift, not the repo standard. Use `## Summary / ## Test Plan / ## Revert Plan` as the floor, and add `## Architecture` when the change affects component interactions or data/control flow.

## Command surface

Preferred repo-local flow:

1. Make sure the branch is based from the canonical base remote.
   Reference: `docs/pr-branching-workflow.md`
2. Push the working branch to the configured publish remote (typically `origin`).
3. Start from the canonical template and validate it:

```bash
cp scripts/pr-body-template.md /tmp/my-pr.md
$EDITOR /tmp/my-pr.md
node scripts/validate-pr-body.mjs --body-file /tmp/my-pr.md
```

4. Create or update the PR with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file /tmp/my-pr.md
```

Update an existing PR with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file /tmp/my-pr.md --update <pr-number>
```

This script handles local image path upload/injection when configured.

## Upstream-first workflow

Use the canonical repository as the PR target and an explicit publish remote (typically `origin`) for branch publication.

- Do not depend on fork-sync scripts before PR creation.
- Create branches from `<baseRemote>/<base>` (for example `origin/master` when `origin` is the canonical clone remote).
- Push branches to the chosen publish remote.
- Open PRs against the canonical repository base branch.

Reference:

- `docs/pr-branching-workflow.md`

## Publication strategy

The execution engine resolves the publication provider via `publicationStrategy` on the workflow. This skill handles the PR authoring step; the engine handles provider dispatch.

| `publicationStrategy` | PR creation | When to use |
|---|---|---|
| `github_pr` (default) | `GitHubMergeGateProvider` creates a standard GitHub PR | All repos unless they opt into Mergify Stacks |
| `mergify_stack` (opt-in) | `MergifyStackProvider` runs `mergify stack push` | Invoker-on-Invoker (`EdbertChan/Invoker`, `Neko-Catpital-Labs/Invoker`) or repos that independently use Mergify Stacks |

For `mergify_stack` workflows:

- use the preferred PR schema above
- keep stack publication explicit
- when the branch stack is ready, publish or update it with:

```bash
mergify stack push
```

Do not set `mergify_stack` on workflows targeting repos that do not use Mergify Stacks.

**Known limitations** (lifecycle PoC: `docs/mergify-stack-lifecycle-poc.md`): mid-stack rewrites recreate PRs (losing comments); re-push after cancel requires closing downstream PRs first.

## Validation

Before creating a PR:

- ensure the branch is pushed
- ensure the body sections are present and concrete
- ensure test commands are real commands that were actually run when possible
- ensure revert guidance is honest
- validate the body with `node scripts/validate-pr-body.mjs --body-file <file>`

If you include `## Architecture`, keep the diagrams renderable by GitHub Mermaid.
Reference:

- `scripts/test-pr-diagrams.sh`

## References

- `docs/pr-branching-workflow.md`
- `scripts/create-pr.mjs`
- `scripts/pr-body-template.md`
- `scripts/validate-pr-body.mjs`
- `scripts/test-pr-diagrams.sh`
