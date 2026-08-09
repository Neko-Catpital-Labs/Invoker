---
name: prove-it
description: >
  Shared evidence rule for every claim about code, UI, or live Invoker state:
  do not assert something is fixed, working, passing, merged, or running
  unless you personally observed it this turn and can show what you saw.
---

# prove-it

Referenced by `make-pr`, `visual-proof`, `land-stack`, and `invoker-ops`. One rule, kept in one place, so it cannot drift out of sync across skills.

## Why this exists

Claiming something is fixed, working, or merged without actually checking it live is a recurring failure mode in this project: a "fixed" PR claim that turned out to still show the bug in its own proof video, visual proof screenshots reused from a stale build, and status reports ("it's merged," "N tasks are running," "autofix kicked in") repeated from memory instead of a fresh query. In every case a cheaper, easier-to-check signal stood in for the thing that was actually asked about, and nobody looked at the real evidence before stating the claim as settled.

## The rule

Before writing any claim of the form "this is fixed," "this now works," "this shows X," "this is merged," "N tasks are running," or similar — in a PR body, a chat reply, or a status report — you must have, in the SAME turn:

1. **For a visual/UI claim:** actually opened the exact screenshot or video yourself (`Read` the image, or extract and `Read` video frames) and can state precisely what you saw. An automated DOM assertion, a test passing, or a file existing at the expected path is not a substitute for looking. Never trust a proxy signal ("the panel is visible") as evidence for a different claim ("the camera did not move") — check the literal thing that was reported broken.
2. **For a live-system claim** (CI status, merge status, task/workflow counts, "it's running," "it's fixed," "autofix kicked in"): run the exact query command fresh in this turn and cite its real output. Never restate a count or status from earlier in the conversation as if it were still current — state drifts while you work.
3. **For a "root cause" claim:** you instrumented or traced the actual failing behavior (logging, a MutationObserver, a debugger, a repro script) rather than pattern-matching to a bug that looked similar. A hypothesis that has not been directly observed is a guess, and must be stated as one.

If you have not done one of the above, either do it now or write `UNVERIFIED:` immediately before the claim — never state it as settled fact.

## Where this is enforced mechanically

- `scripts/validate-pr-body.mjs` rejects a `## Visual Proof` section that has media but no `Manually inspected:` line describing what was actually seen.
- Everything else on this page is a discipline, not a mechanical gate. Treat the gate as the floor, not the ceiling — the rest still applies even where nothing will stop you from skipping it.
