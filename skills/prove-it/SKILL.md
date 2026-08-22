---
name: prove-it
description: >
  Shared evidence rule for investigating, diagnosing, debugging, proving, or explaining what happened or why for any problem or situation:
  do not assert something is fixed, working, passing, merged, or running
  unless you personally observed it this turn and can show what you saw; do not
  assert it was caused by X until a repro and controlled isolation prove that
  cause.
---

# prove-it

Referenced by `make-pr`, `visual-proof`, `land-stack`, and `invoker-ops`. One rule, kept in one place, so it cannot drift out of sync across skills.

## Why this exists

Claiming something is fixed, working, merged, or understood without actually checking it live is a recurring failure mode in this project: a "fixed" PR claim that turned out to still show the bug in its own proof video, visual proof screenshots reused from a stale build, status reports ("it's merged," "N tasks are running," "autofix kicked in") repeated from memory instead of a fresh query, and correction replies that explained a cause before reproducing the literal failure. In every case a cheaper, easier-to-check signal stood in for the thing that was actually asked about, and nobody looked at the real evidence before stating the claim as settled.

## The rule

This skill applies at the start of any investigation into a problem or situation, including requests to investigate, diagnose, debug, prove, explain what happened, explain why something happened, or determine why a behavior occurred. Begin read-only unless the user requested changes.

Before writing any claim of the form "this is fixed," "this now works," "this shows X," "this is merged," "N tasks are running," "the cause is X," or similar — in a PR body, a chat reply, or a status report — you must have, in the SAME turn:

1. **For a visual/UI claim:** actually opened the exact screenshot or video yourself (`Read` the image, or extract and `Read` video frames) and can state precisely what you saw. An automated DOM assertion, a test passing, or a file existing at the expected path is not a substitute for looking. Never trust a proxy signal ("the panel is visible") as evidence for a different claim ("the camera did not move") — check the literal thing that was reported broken.
2. **For a live-system claim** (CI status, merge status, task/workflow counts, "it's running," "it's fixed," "autofix kicked in"): run the exact query command fresh in this turn and cite its real output. Never restate a count or status from earlier in the conversation as if it were still current — state drifts while you work.
3. **For a problem or situation investigation:** first restate the literal reported behavior and resolve the current target being investigated. Then author and execute a task-specific repro that visibly fails against that current target before explaining why. The repro must exercise the reported behavior itself, not a proxy such as "a related test passed," "the file exists," "the panel rendered," or "the logs looked similar."
4. **For a "root cause" claim:** isolate the suspected cause with a controlled comparison in the actual failing path (for example logging, a MutationObserver, a debugger, a repro script, a one-variable change, or another task-specific control) rather than pattern-matching to a bug that looked similar. A hypothesis that has not been directly observed is a guess, and must be stated as one. If the user says a retry/repair loop does not continue until X, search `*Limit` / `*budget` / `fails closed after` before assuming the loop is absent — a bound is often the whole bug.
5. **For a fix/resolution claim:** rerun the same repro that failed before the fix and show the real passing output. A different test, a broader suite, or a screenshot of a nearby state can supplement the repro but cannot replace it.

If you have not done one of the above, either do it now or write `UNVERIFIED:` immediately before the claim — never state it as settled fact. All unproven causal hypotheses must be prefixed with `UNVERIFIED:`.

## Investigation sequence

When asked what happened, why it happened, or to investigate/diagnose/debug a problem:

1. Restate the literal reported behavior and the current target.
2. Build and run an executable repro against that target; show the real failing output.
3. Isolate the proposed cause with a controlled comparison; show the real output.
4. Only then explain the cause. If isolation is missing, prefix the explanation with `UNVERIFIED:`.
5. If you changed anything, rerun the same repro and show the real passing output before claiming resolution.

## Examples this rule is meant to stop

- Proxy proof: do not cite "a test passed" when the reported failure was visual or behavioral and was never exercised.
- Wrong-target verify command: do not treat an automated task template's default `verify_command`/"Acceptance criteria" as proof without checking it actually invokes the changed file. A fleet CI-repair chain filed `pnpm --filter @invoker/ui test` as its acceptance command for a fix that only touched `scripts/test-ci-workflow-merge-queue-policy.mjs` — a script wired only into the root `pnpm test` chain, never into the UI package's own test script (confirmed by running both: `pnpm --filter @invoker/ui test` never references the file, while `node scripts/test-ci-workflow-merge-queue-policy.mjs` does and passes). The picker had chosen the shortest verify command among several unrelated jobs bundled into one event, not the one covering the job actually diagnosed and fixed — so the recorded "Exit code: 0" most likely proved an unrelated, already-passing suite, not the fix.
- Stale state: do not report an old merge, CI, task, or workflow status without a fresh live query.
- Wrong target: do not reproduce against a sample, another branch, another PR, or another deployment unless you label the result as not the current target.
- Broken repro: do not explain a failure from a repro that did not execute, did not fail, or failed for setup reasons.
- Premature theory: do not name a cause before an executable failing repro and controlled isolation support it.
- Scope drift: do not mutate systems, broaden product behavior, or start fixing during a read-only investigation unless the user requested changes.
- Assertion mismatch: do not claim the proof shows one thing when the output only demonstrates a weaker or different fact.
- Visual mismatch: do not rely on DOM, file, or path checks instead of opening the exact screenshot or video and stating what you saw.
- Live-state mismatch: do not use remembered counts or statuses as current evidence for running, merged, queued, or failed work.
- Intent from one data point: do not assert malicious intent (e.g. "someone snuck this in") from a suspicious name plus a single supporting fact. Ask before accusing — a workflow literally named `jailbreak-admin-bypass-land` turned out to be a deliberately built feature; the user had to correct it directly.
- Log-line misattribution: do not assume a single log line's meaning without checking what code actually emits it. "Confirmed... a severe crash loop" was delivered from counting `"module":"startup"` lines, without checking that the same banner prints on every CLI invocation, not only on an owner restart — self-caught, but only after the user had already acted on the claim.
- Single-machine absence as proof: do not conclude "never pushed" or "doesn't exist" from one machine's local git/file state. Check the actual remote (`gh api`, `git ls-remote`) independently before asserting something is missing — a commit that looked stranded on one host was already sitting on GitHub, just not yet fetched elsewhere.

## Where this is enforced mechanically

- `scripts/validate-pr-body.mjs` rejects a `## Visual Proof` section that has media but no `Manually inspected:` line describing what was actually seen.
- Everything else on this page is a discipline, not a mechanical gate. Treat the gate as the floor, not the ceiling — the rest still applies even where nothing will stop you from skipping it.
