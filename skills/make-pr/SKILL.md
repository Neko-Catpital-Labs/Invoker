---
name: make-pr
description: >
  Create or update a pull request in this repo using the preferred PR schema,
  explicit base/publish remotes, and repo-specific publication rules. Trigger
  when asked to make a PR, update a PR body, prepare PR text, or publish a
  stacked PR branch.
---

# make-pr

Use this skill when the work is already done and the user wants a PR created, updated, or rewritten.

## What this skill covers

- PR title/body authoring for Invoker
- The preferred PR section schema
- Explicit base/publish remote PR workflow
- Repo-specific publication rules:
  - Invoker-on-Invoker stacks use an origin-only Mergify stack workflow
  - unrelated target repos should keep their own normal PR workflow unless they independently use Mergify Stacks

When an Invoker review gate emits multiple PR artifacts, each PR body still uses this same schema, and Invoker-on-Invoker stacks are still published with `mergify stack push`.
## Preferred PR schema

Default to this structure:

```md
## Summary

Plain-English explanation of what changed and why.

First paragraph must state the new behavior or contract in simple English.

Do not open with debugging history, investigation notes, or a blow-by-blow narrative.

Write this for a burnt out developer who needs the point quickly.

Use paragraphs, not bullets. Keep each paragraph under 30 words.

Put one idea in each paragraph. If one idea leads to another, split them into separate short paragraphs.

Avoid implementation jargon unless it is necessary for understanding the change.

## Review Claim

State the one thing the reviewer is being asked to approve.

## Review Lane

Choose exactly one: `behavior`, `refactor`, `proof`, `cleanup`, `policy`, or `docs`.

## Safety Invariant

Explain why this slice is safe to review locally.

## Slice Rationale

Explain why this work is split here instead of bundled elsewhere.

## Non-goals

List what this slice explicitly does not change.

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

## Visual Proof

Required when the diff changes UI-impacting files. Include before/after screenshots or a video link.

## Revert Plan

- Safe to revert? Yes/No
- Revert command: `git revert <sha>` or equivalent
- Post-revert steps: None / concrete steps
- Data migration? No / concrete steps
```

If the change is small and has no architectural impact, omit `## Architecture` rather than forcing filler.

If the change touches UI-impacting files, use `skills/visual-proof/SKILL.md` first and include its screenshot/video markdown in `## Visual Proof`. UI-impacting files include `packages/ui/**`, Electron window lifecycle files, preload, main process window wiring, and app menu changes.

Do not default to a lightweight `## Summary / ## Testing / ## Notes` PR body. That shape is ad hoc drift, not the repo standard. Use `## Summary / ## Review Claim / ## Review Lane / ## Safety Invariant / ## Slice Rationale / ## Non-goals / ## Test Plan / ## Revert Plan` as the floor, add `## Visual Proof` for UI-impacting diffs, and add `## Architecture` when the change affects component interactions or data/control flow.

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

Update an existing PR by number with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file /tmp/my-pr.md --update <pr-number>
```

Update the PR already attached to the current branch with:

```bash
node scripts/create-pr.mjs --title "<title>" --base master --body-file /tmp/my-pr.md --update-existing
```

This script handles local image path upload/injection when configured. It also rejects UI-impacting diffs unless the body includes visual proof media.

## Explicit remote workflow

Use the canonical repository as the PR target and an explicit publish remote.

- Keep the generic rule for unrelated repos: create branches from `<baseRemote>/<base>`, push to the chosen publish remote, and open PRs against the canonical repository base branch.
- Do not depend on fork-sync scripts before PR creation.

Reference:

- `docs/pr-branching-workflow.md`

## Invoker-specific publication rule

If the target repo is Invoker itself (`EdbertChan/Invoker` or `Neko-Catpital-Labs/Invoker`):

- use `origin` as the base remote, publish remote, and PR target repo
- if the finished work is too large for one PR, use `skills/review-compression/SKILL.md` first to define the slice order before creating any PR branches
- create the first slice with `bash scripts/create-clean-pr-branch.sh --base-remote origin --publish-remote origin --base-ref <base> pr/<slice-1> <commit ...>`
- after pushing `pr/<slice-1>`, restore its local target with `git branch --set-upstream-to=origin/<base> pr/<slice-1>`
- after pushing `pr/<slice-1>`, create `pr/<slice-2>` and later slices with the same helper but `--base-ref pr/<previous-slice>`
- after pushing each later slice, restore its local target with `git branch --set-upstream-to=origin/pr/<previous-slice> pr/<slice-N>`
- direct `git push` on a Mergify-managed stack branch is expected to fail because the hook blocks it
- publish stack branches with `mergify stack push`
- after `mergify stack push`, repair PR titles or bodies as a second step by rerunning `create-pr` in update mode on the created stack branch
- do not recreate an existing stack PR by cherry-picking into a fresh `land/*` or ad hoc branch, because GitHub and Mergify will open a new PR instead of updating the existing one

The `git push -u` step points a local stack branch at itself. Reset the local target back to the intended base branch before `mergify stack push`, or Mergify will reject the stack as self-targeting.

Large diff to stack sequence:

1. review-compress the work into ordered slices
2. create and push `pr/<slice-1>` from `origin/<base>`
3. run `git branch --set-upstream-to=origin/<base> pr/<slice-1>`
4. create and push each later `pr/<slice-N>` from `origin/pr/<slice-(N-1)>`
5. run `git branch --set-upstream-to=origin/pr/<slice-(N-1)> pr/<slice-N>` for each later slice
6. run `mergify stack push` only after the branch stack exists
7. rerun `create-pr` in update mode on each stack branch to patch the PR bodies

Stack PR body update example:

```bash
mergify stack push
git switch pr/<slice-name>
node scripts/create-pr.mjs --title "<title>" --base <base> --body-file /tmp/my-pr.md --update-existing
```

For self-authored PRs to `master` that need the repo's admin queue path, add the `admin-bypass` label and then queue the PR with the `admin-bypass` rule.

Do not generalize this to unrelated repos.

## Validation

Before creating a PR:

- ensure the branch is pushed
- ensure the body sections are present and concrete
- ensure test commands are real commands that were actually run when possible
- ensure revert guidance is honest
- validate the body with `node scripts/validate-pr-body.mjs --body-file <file>`
- for UI-impacting diffs, include `## Visual Proof` with screenshot or video proof before `node scripts/create-pr.mjs`

If you include `## Architecture`, keep the diagrams renderable by GitHub Mermaid.
Reference:

- `scripts/test-pr-diagrams.sh`

## References

- `docs/pr-branching-workflow.md`
- `scripts/create-pr.mjs`
- `scripts/pr-body-template.md`
- `scripts/validate-pr-body.mjs`
- `scripts/test-pr-diagrams.sh`
