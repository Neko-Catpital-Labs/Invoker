---
name: land-stack
category: core
description: >
  Land (queue/merge) a Mergify-managed PR stack safely. Trigger when asked to
  land, merge, ship, or queue a PR or PR stack with Mergify. Enforces that you
  act only on SHA-verified PR numbers — never a PR found by branch name.
---

# land-stack

Use this skill whenever the user asks to **land / merge / ship / queue** a PR or a PR stack.

## Hard rule

**Never identify the PR to land by branch name.** Two different PRs can share a
branch name (an auto-generated workflow branch PR and the intended `stack/...`
PR). You must land by **SHA-verified PR number**, and every PR must pass the guard
before any write (label, thread-resolve, queue, merge).

## How Mergify lands a stack (batch_size: 1)

The admin-bypass queue in `.mergify.yml` has `batch_size: 1` and requires
`base=master`. Only the current bottom PR can enter the queue. After it
squash-merges, Mergify retargets the next PR onto master and that PR can queue.
A repaired, fully labeled stack still lands **one PR per queue cycle** (~20 min
each). Repairing the whole stack does not put every layer into one Mergify
batch. That batching was dropped in #2354 after speculative-batch flakes
dequeued entire stacks; nothing in the repo restores it.

`--execute` labels every verified PR with `admin-bypass`. That clears the
babysitter's upper-stack-acceptance gate and lets each next bottom auto-queue
after retarget. It is not a single-batch merge of the stack.

## Steps

1. **Resolve PR numbers, bottom of stack first.** If the user gives numbers or
   URLs, use those. If they do not, make a best-effort read-only discovery pass
   and suggest the numbers yourself:

   - Enumerate open PRs broadly, for example with `gh pr list --state open
     --json number,baseRefName,headRefName,headRefOid,title --limit 100`.
   - Filter to candidates whose `headRefName` starts with `stack/`.
   - Prefer candidates whose `headRefOid` exists in the local clone, so the code
     is actually available for review.
   - Order the stack by base/head links: the bottom PR targets the trunk; each
     later PR targets the previous PR's head branch.
   - Detect whether two or more open candidates share the same `headRefName`.
     If they do, present the exact bottom-up PR numbers and ask the user to
     confirm them before landing. This is the only discovery case that requires
     confirmation.
   - If every candidate `headRefName` is unique, run the guard on the suggested
     sequence and, when it passes, land it without an additional confirmation.
     The requested landing action plus a SHA-verified, guarded PR sequence is
     sufficient authorization.

   Never discover by branch name. Do not run `gh pr list --head <branch>` to
   decide what to land; that is the unsafe path this skill exists to prevent.

2. **Verify with the guard — it must exit 0:**

   ```bash
   node scripts/land-stack.mjs <bottom-pr> <next-pr> ...
   ```

   The guard checks, for each PR: head SHA exists in the local clone (it is the
   code you reviewed), head branch is a real `stack/` branch (rejects raw
   workflow branches), the PRs form a proper stack (each base is the previous
   head; the bottom's base is the trunk), and all are OPEN. If any check FAILs,
   stop and resolve the mismatch with a fresh discovery pass — do not work around it.

3. **Label the full verified stack once:**

   ```bash
   node scripts/land-stack.mjs <bottom-pr> ... --execute
   ```

   Pass every open stack PR number, bottom-to-top. This re-verifies, then adds
   `admin-bypass` to **every** PR in the stack. Only the bottom (base == trunk)
   enters the Mergify queue immediately. Use `admin-bypass` only because
   self-authored PRs cannot be self-approved; if a human can approve, prefer a
   real approval + `ready-to-merge`.

4. **Wait for each bottom PR to merge in turn.** Mergify re-runs the full suite
   on that one queued PR (can take ~20 min). When it merges, the next PR
   auto-re-targets the trunk. If it already has `admin-bypass`, it auto-queues;
   otherwise the babysitter or a fresh land-stack pass can re-label/requeue.

5. **Watch remaining open stack PRs until they merge.** Do not expect one
   Mergify batch for the whole stack. Re-run the guard only if a later PR lost
   its label, failed checks, or needs a new human decision.

## Do not

- Do not `gh pr merge` or hand-add `admin-bypass` to skip the guard.
- Do not resolve review threads to unblock a merge by default. Decision tree:
  - **Babysit-until-merged + bot thread** (CodeRabbit or similar): after the
    current head addresses the thread (or the thread is outdated), resolve it
    yourself via the GitHub review-thread API. Do not bounce that to the user.
  - **Human review thread:** resolve only when the user has decided to defer
    those findings; record the deferral on the PR. This rule alone never
    authorizes resolving a human thread.
  - **No babysit / not addressing the thread:** leave the thread open.
- Do not act on a PR whose head SHA is not in your local clone.
- Do not tell the user that labeling the stack merges it as one Mergify batch.

## Prove state before reporting it

Before telling the user a PR is merged, queued, blocked, or failing CI, re-run the exact `gh pr view`/queue query in that same turn — do not repeat a status you checked earlier in the conversation. "Merging" is not "merged"; a queued PR can still fail the re-run suite. See `skills/prove-it/SKILL.md`.

## Why this exists

A raw workflow-branch PR (#505) shared a branch name with the intended stack
(#2174 / #2175). Landing "the PR on this branch" by name queued the wrong PR.
The guard makes that mistake fail closed instead of merging silently.
