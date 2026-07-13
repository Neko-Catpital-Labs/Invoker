# CI: flaky / batch-only check failures stalling the merge queue

**Date:** 2026-06-24
**Context:** Landing the **[pr-skill robustness]** stack (#2225–#2260) through the Mergify admin-bypass queue repeatedly stalled. Each dequeue was investigated. One real bug surfaced (now fixed); two checks fail only inside Mergify's speculative batch and are the candidates for flaky-test treatment.

This is a tracking ticket (GitHub issues are disabled on the repo) so we can decide whether to stabilize or simply quarantine/disable the offenders.

---

## 1. `required-fast / Vitest Workspace` — REAL bug, already fixed (not flaky)

- **Symptom:** dequeued the stack twice in a row — consistent, not random.
- **Root cause:** two tests in `packages/execution-engine/src/__tests__/task-runner-fix-publish-and-ssh.test.ts` resolved the `make-pr` skill from the **real `~/.claude/skills/invoker-make-pr`**. That skill exists on a dev laptop but **not in CI**, so the agent was skipped and a different error was thrown — the tests passed locally and failed only in CI's full workspace run.
  - `publishReviewStackWithMakePrSkill rejects a commit-message body … (PR #2170 regression)`
  - `publishReviewStackWithMakePrSkill validates the published body, not just the agent-reported one`
- **Fix:** both tests now create a temp skill dir and set `bundledSkillRoot` (matching the existing isolated tests). Verified passing with an empty `$HOME`. Shipped in #2229 / #2230.
- **Follow-up (prevention):** any test that reads the real `~/.claude` / `~/.codex` skills instead of an isolated `bundledSkillRoot` is a latent CI-only failure. Add a guard (lint/grep in CI) that flags `bundledSkills` in a test without a matching `bundledSkillRoot`.

## 2. `dry-run / case-2` — suspected flaky (batch-only)

- **Symptom:** failed on the Mergify speculative draft (#2294 / #2301) but **passed on the individual PR (#2227) and on master**.
- Could be true flakiness or a batch-combination / resource-contention effect.

## 3. `playwright / 2-of-3` — suspected flaky (batch-only)

- Same signature as #2: failed on the speculative draft, passed on the individual PR and on master. Playwright e2e shards are a common flake source.

---

## Mitigation already applied

- **#2354** dropped the **admin-bypass queue `batch_size` from 5 → 1**, so a single flaky check can no longer fail an entire batch of stacked PRs. The default queue is unchanged.

## Proposed next steps

1. Pull re-run history for `dry-run / case-2` and `playwright / 2-of-3` to confirm flakiness (pass rate on unchanged commits).
2. If confirmed flaky and not quickly stabilizable: **quarantine/disable** them (skip + a linked tracking note) rather than letting them gate the queue — likely the cheapest fix.
3. Add the test guard from §1 so CI-only skill-resolution failures can't ship again.

_Filed while landing the pr-skill stack; 5/8 PRs already merged (#2225–#2229), last 3 in flight._
