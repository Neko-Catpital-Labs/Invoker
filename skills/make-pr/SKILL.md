---
name: make-pr
description: >
  Create or update a pull request in this repo using the preferred PR schema,
  parent-remote branch workflow, and repo-specific publication rules. Trigger
  when asked to make a PR, update a PR body, prepare PR text, or publish a
  stacked PR branch.
---

# make-pr

Use this skill when the work is already done and the user wants a PR created, updated, or rewritten.

## What this skill covers

- PR title/body authoring for Invoker
- The preferred PR section schema
- Parent-remote branch/PR workflow (`origin` fork + `upstream` parent)
- Repo-specific publication rules:
  - Invoker-on-Invoker stacks may use `mergify stack push`
  - unrelated target repos should keep their own normal PR workflow unless they independently use Mergify Stacks

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

1. Make sure the branch is based from the parent remote, not the fork.
   Reference: `docs/pr-branching-workflow.md`
2. Push the working branch to `origin`.
3. Create or update the PR with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file <file>
```

Update an existing PR with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file <file> --update <pr-number>
```

This script handles local image path upload/injection when configured.

## Parent-remote workflow

Use the parent repository as the PR target and `origin` as the push remote.

- Never push working branches to the parent remote.
- Create branches from `upstream/<base>` (or the configured parent remote), not `origin/<base>`.
- Open PRs against the parent repository base branch.

Reference:

- `docs/pr-branching-workflow.md`

## Invoker-specific publication rule

If the target repo is Invoker itself (`EdbertChan/Invoker` or `Neko-Catpital-Labs/Invoker`):

- use the preferred PR schema above
- keep stack publication explicit
- when the branch stack is ready, publish or update it with:

```bash
mergify stack push
```

Do not generalize this to unrelated repos.

## Validation

Before creating a PR:

- ensure the branch is pushed
- ensure the body sections are present and concrete
- ensure test commands are real commands that were actually run when possible
- ensure revert guidance is honest

If you include `## Architecture`, keep the diagrams renderable by GitHub Mermaid.
Reference:

- `scripts/test-pr-diagrams.sh`

## References

- `docs/pr-branching-workflow.md`
- `scripts/create-pr.mjs`
- `scripts/test-pr-diagrams.sh`
