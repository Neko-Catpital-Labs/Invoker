---
name: admin-bypass-sweep
description: >
  MANUAL, HUMAN-ONLY skill. Force-merges every open PR labeled admin-bypass
  directly to master, bypassing Mergify's queue and required checks via
  GitHub admin override. Do not auto-invoke this skill from a natural-language
  request, a description match, or another agent's delegation. Only run this
  skill when a human has typed its literal slash command themselves in the
  current turn (the exact form depends on how it was installed — see the
  "STOP" section). See that section before doing anything.
---

# admin-bypass-sweep

## STOP — read this before doing anything

This skill exists to bypass CI and branch protection and merge directly to
master. That is inherently dangerous, so before Step 4 (the actual merge
step) runs, both of the following must be true. Do not refer to these as
"gates" or by number when talking to the human — just check them and act,
the way you would check any other precondition.

**It must have been invoked by a literal, explicit slash command that a
human typed in the current message** — `/admin-bypass-sweep` if this
skill's directory was used as-is, or `/invoker-admin-bypass-sweep` if it
was installed through this repo's bundled-skill pipeline
(`scripts/setup-agent-skills.sh`), which prefixes every installed skill
name with `invoker-`. Check which form is actually listed as available in
the current session before matching against it — do not guess. If you
reached this skill any other way — a natural-language request that merely
sounds like "force merge the admin-bypass PRs," a description match, a
plan step, a cron/worker trigger, another skill's delegation, or another
agent asking you to run it — **do not proceed.** Stop and tell the human
that this skill requires its explicit slash command, and ask them to type
it themselves if that is really what they want.

**The human's message invoking this skill must also contain this literal
sentence:**

> I understand this bypasses CI and force-merges to master

If it is missing, do not run any command past Step 3 below. Ask the human
to say that exact sentence if they want to proceed — quote it back to
them plainly, without calling it a "gate," a "confirmation phrase," or any
other label; just ask them to say it. Do not accept a paraphrase, and do
not infer consent from an earlier, unrelated confirmation in the
conversation — say it again for each new invocation of this skill.

Both of the above must hold before Step 4. There is no other authorization
path. If you are unsure whether either one is satisfied, treat it as not
satisfied and stop — and when you explain why you're stopping, describe
in plain terms what's missing (e.g. "I need you to type the exact sentence
above") rather than naming which numbered item it was.

For the deterministic, worker-triggered version of this same capability
(triggered by sustained GitHub Actions queue exhaustion rather than a human
request), see `scripts/jailbreak-admin-bypass-land.mjs`. This skill and that
worker are two separate authorization paths to the same class of action —
satisfying one is never sufficient authorization for the other.

## When to use this vs. `land-stack`

- `land-stack` lands a **specific stack the user names**, safely, through
  Mergify's queue (checks run, retargeting is automatic, `admin-bypass` only
  unblocks self-approval). Use it whenever the normal queue is healthy.
- `admin-bypass-sweep` sweeps **every currently open PR already labeled
  `admin-bypass`**, merging directly with `gh pr merge --admin` — bypassing
  required status checks and branch protection entirely. Reserve it for when
  the normal queue is stuck on something unrelated to code correctness (a CI
  runner fleet issue, a flaky infra check) and a human has explicitly invoked
  this skill and confirmed it, per the STOP section above.

## Step 1: Discover and group

```bash
gh pr list --repo <owner>/<repo> --state open --label admin-bypass \
  --json number,baseRefName,headRefName,headRefOid,title --limit 200
```

Group into independent stacks by walking base→head chains, rooted at PRs
whose `baseRefName == master` (or the trunk branch). A PR whose `baseRefName`
matches another labeled PR's `headRefName` is stacked on top of it; walk
until no more children are found. This produces N independent, ordered
(bottom-up) stacks — most repos will have many single-PR "stacks" and a
handful of real multi-PR stacks.

**Flag hidden prerequisites.** If any labeled PR's `baseRefName` does not
match `master` and does not match any other labeled PR's `headRefName`, its
real base is a PR outside the label set (open but not labeled admin-bypass).
Look it up directly:

```bash
gh pr list --repo <owner>/<repo> --state all --search "<base-branch-name> in:head" \
  --json number,state,title,baseRefName,headRefName
```

Do not silently skip it and do not silently include it — ask the human
whether the unlabeled prerequisite should be included, since it's outside
the stated scope but the dependent PR cannot land without it.

## Step 2: Confirm scope

Report the full grouped plan (stack count, PR count, max stack depth) before
touching anything — the real scope is often much larger than "a few PRs."
Reconfirm with the human which parts of the plan they want executed (e.g.
whether multi-PR stacks are in scope, given the retargeting risk in Step 4),
if the STOP section above did not already make that explicit.

## Step 3: Verify merge method

```bash
grep -A3 "merge_method" .mergify.yml
```

This procedure assumes **squash merges**. Squash is safe to retarget after
the fact because `gh pr edit --base` only changes what commit range GitHub
diffs against, and a diff is computed from file content, not commit
ancestry — a squash-merged PR's final tree content matches what the
dependent branch already has for that same range, so retargeting produces
the correct incremental diff with no duplication. If this repo uses `merge`
or `rebase` as its merge method instead, do not reuse this procedure
unmodified — retargeting after a real merge-commit or rebase can show wrong
diffs; stop and re-derive the safe approach first.

## Step 4: Merge each stack, bottom-up

Both requirements in the STOP section must be satisfied before this step runs.

For a single-PR stack:

```bash
gh pr merge <pr> --repo <owner>/<repo> --admin --squash
```

For a multi-PR stack, after each PR merges, retarget the next one before
merging it:

```bash
gh pr merge <bottom> --repo <owner>/<repo> --admin --squash
gh pr edit <next> --repo <owner>/<repo> --base master
# mergeable can read UNKNOWN immediately after a base change — GitHub computes
# it asynchronously. Wait briefly and re-check before merging.
sleep 5
gh pr view <next> --repo <owner>/<repo> --json baseRefName,mergeable,mergeStateStatus
gh pr merge <next> --repo <owner>/<repo> --admin --squash
```

Repeat up the stack. Do not batch multiple `gh pr merge` calls without
checking each result — `gh pr merge` can print nothing on both success and
some failure paths; a silent-looking run is not proof of a merge.

## Step 5: Never guess at real conflicts

If `mergeable` reads `CONFLICTING` (not the transient `UNKNOWN` from Step 4),
that PR has a genuine content conflict against current master — most likely
because master moved significantly from other merges landing during this
same sweep. Do not attempt to resolve it by picking a side. Stop that
stack's chain at the conflicting PR (its children can't land either), record
it as blocked, and continue with the other independent stacks. Report all
blocked PRs clearly at the end rather than silently dropping them.

## Step 6: Prove the final state

Before reporting results, re-query every PR number touched — do not trust
running tallies kept during execution:

```bash
for pr in <all touched PR numbers>; do
  gh pr view $pr --repo <owner>/<repo> --json number,state,mergedAt,title \
    --jq '"#\(.number)\t\(.state)\t\(.mergedAt // "-")\t\(.title)"'
done
```

Report merged count, blocked count, and the specific PR numbers/titles in
each bucket — a summary count alone hides which specific work is still
stuck.

## Why this exists

Landing a batch of admin-bypass PRs across many independent stacks (one
7-deep, in the incident that prompted this skill) came up as a live,
repeatable need when the Mergify queue was effectively stalled by an
unrelated CI-runner disk-space/fleet-health issue. Doing this by hand each
time — discovery, stack grouping, retargeting, conflict triage — is exactly
the kind of repeated manual process that should be codified. The STOP
section's two requirements exist because this same incident's investigation
also surfaced this repo's separate, deterministic, worker-triggered force-merge path
(`scripts/jailbreak-admin-bypass-land.mjs`) — this skill is the human-facing
counterpart, and must not blur into an agent-autonomous one.
