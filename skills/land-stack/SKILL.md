---
name: land-stack
description: >
  Land (queue/merge) a Mergify-managed PR stack safely. Trigger when asked to
  land, merge, ship, or queue a PR or PR stack with Mergify. Enforces that you
  act on explicit, SHA-verified PR numbers — never a PR found by branch name.
---

# land-stack

Use this skill whenever the user asks to **land / merge / ship / queue** a PR or a PR stack.

## Hard rule

**Never identify the PR to land by branch name.** Two different PRs can share a
branch name (an auto-generated workflow branch PR and the intended `stack/...`
PR). You must land by **explicit PR number**, and every PR must pass the guard
before any write (label, thread-resolve, queue, merge).

## Steps

1. **Get explicit PR numbers from the user**, bottom of stack first. If they
   give a URL, read the number from it. Do not run `gh pr list --head <branch>`
   to discover what to land.

2. **Verify with the guard — it must exit 0:**

   ```bash
   node scripts/land-stack.mjs <bottom-pr> <next-pr> ...
   ```

   The guard checks, for each PR: head SHA exists in the local clone (it is the
   code you reviewed), head branch is a real `stack/` branch (rejects raw
   workflow branches), the PRs form a proper stack (each base is the previous
   head; the bottom's base is the trunk), and all are OPEN. If any check FAILs,
   stop and reconfirm the PR numbers with the user — do not work around it.

3. **Land bottom-up:**

   ```bash
   node scripts/land-stack.mjs <bottom-pr> ... --execute
   ```

   This re-verifies, then adds `admin-bypass` to the bottom PR (base == trunk)
   to enter the Mergify queue. Use `admin-bypass` only because self-authored PRs
   cannot be self-approved; if a human can approve, prefer a real approval +
   `ready-to-merge`.

4. **Wait for the bottom PR to merge.** Mergify re-runs the full suite on the
   queued batch (can take ~20 min). When it merges, the next PR auto-re-targets
   the trunk.

5. **Re-run step 3 with the remaining PR numbers** until the stack is landed.

## Do not

- Do not `gh pr merge` or hand-add `admin-bypass` to skip the guard.
- Do not resolve review threads to unblock a merge unless the user has decided
  to defer those findings; record the deferral on the PR.
- Do not act on a PR whose head SHA is not in your local clone.

## Why this exists

A raw workflow-branch PR (#505) shared a branch name with the intended stack
(#2174 / #2175). Landing "the PR on this branch" by name queued the wrong PR.
The guard makes that mistake fail closed instead of merging silently.
