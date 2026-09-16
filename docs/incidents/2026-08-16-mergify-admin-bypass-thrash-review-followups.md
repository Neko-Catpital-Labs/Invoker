# Mergify admin-bypass / e2e-worker thrash: review follow-ups

**Date:** 2026-08-16
**Context:** A cross-tool `reflect` retrospective (Claude Code + Codex + OMP transcripts, 30-day window) found the `mergify_admin_requeue_*.py` repair subsystem took **63 commits from 2026-07-07 to 2026-08-15** — patches to the *alarm*, not the underlying gate. This doc records what direct investigation in this repo confirmed, and why two of the retrospective's proposed follow-ups are **not** safe to ship as-is.

---

## 1. Confirmed: the repair subsystem itself is under-tested

`scripts/mergify_admin_requeue_*.py` — 15 source files. 5 have no matching `test_mergify_admin_requeue_*.py` at all:

- `mergify_admin_requeue_exec.py`
- `mergify_admin_requeue_gh_executor.py`
- `mergify_admin_requeue_headless_shell.py`
- `mergify_admin_requeue_loader.py`
- `mergify_admin_requeue_logger.py`

`scripts/test-suites/required/12-mergify-admin-requeue.sh` only ever runs test files that already exist (`for test_file in scripts/test_mergify_admin_requeue*.py`) — a source file added without a matching test file is silently never gated, indefinitely.

## 2. Bigger finding: `e2e-regression-watch.test.mjs` is broken and not wired into CI at all

`scripts/e2e-regression-watch.mjs` is the script this whole thrash pattern centers on (it has an in-progress uncommitted fix on this checkout for a bug where one failure's `fileFailure` throwing killed an entire sweep). Its test file, `scripts/e2e-regression-watch.test.mjs`:

- Is **not referenced anywhere** in `package.json`'s `test`/`test:high-resource` scripts, `scripts/test-suites/`, or `.github/workflows/` — confirmed by grep, zero hits.
- Fails **20 of 23 tests** when actually run (`node --test scripts/e2e-regression-watch.test.mjs`), reproduced both with and without the uncommitted local fix (identical failures on both — pre-existing, not caused by the WIP change). Several failures are expectations pinned to specific CI job names (e.g. `'playwright / launch-dispatch-stuck-lease'`) that no longer match current `ci.yml` — a second, independent instance of the same "job names drift, nothing catches it" failure mode as incident `2026-07-19`.

This is the clearest evidence in this repo of the pattern `reflect` was checking for: a verification step exists, has existed, and has been silently failing/unwired the entire time. Recommend triaging these 20 failures (real bugs vs. stale expectations) and wiring the file into CI — **not done here**, it's a multi-hour investigation of its own and out of scope for this pass.

## 3. `head_sha` retry-cap fix (#9177) — UNVERIFIED whether it reduced burst frequency

`b5c386398a "[Shared Retry Ledger](4a) Retry cap persists across a head_sha change (#9177)"` landed **2026-08-15**, the same day this repair subsystem's 6-week, 63-commit patch streak ends — it is the *last* commit in that streak, not one with any post-landing window to evaluate yet. `UNVERIFIED`: there is currently zero time-after-fix data to say whether it reduced burst frequency. Re-check in 1-2 weeks against `git log --follow -- scripts/mergify_admin_requeue*.py` commit frequency.

## 4. Proposed `bundledSkillRoot` CI lint (from `2026-06-24-ci-flaky-tests-merge-queue.md` §1) — do not ship the naive version

The incident doc proposes: "Add a guard (lint/grep in CI) that flags `bundledSkills` in a test without a matching `bundledSkillRoot`." Tested this literally against `packages/execution-engine/src/__tests__/task-runner-fix-publish-and-ssh.test.ts` (the file the original bug was in): of 5 occurrences of `bundledSkills:` with no `bundledSkillRoot` in the same enclosing `it()` block, **0 were real bugs**:

- 4 are fully mocked agents (`buildCommand: () => ({ cmd: 'node', args: ['-e', '...'] })`) that never touch real skill-path resolution at all — `bundledSkillRoot` is meaningless for them.
- 1 (`line 2033`) deliberately sets `process.env.HOME` to an isolated, empty temp dir with **no** skill directories created in it, specifically to test the "no skill found → canonical fallback" behavior — omitting `bundledSkillRoot` is the point of that test, not a bug.

A naive version of this lint would be **100% false-positive rate** against the current suite, immediately need an allowlist nobody asked for, and erode trust in whatever's built. A safe version needs a real signal — "does the test set `process.env.HOME` to a directory that plausibly reads the real developer's `~/.claude`/`~/.codex` skills" — which isn't reliably greppable; it needs the actual agent construction + skill-resolution code path traced. Not built here; flagging so nobody ships the doc's literal two-line proposal expecting it to be safe.

## 5. Flaky-test quarantine + pass-rate tracking — not specified anywhere, not built

The `reflect` retrospective's Backlog item #5 described this as a proposal from the incident docs. Re-reading both `2026-06-24-ci-flaky-tests-merge-queue.md` and `2026-07-19-git-e2e-master-head.md` directly: the only concrete ask is §"Proposed next steps" #2 in the 2026-06-24 doc — "quarantine/disable" two *specific, named* checks (`dry-run / case-2`, `playwright / 2-of-3`) *if* re-run history confirms they're flaky. No re-run history is available from this local checkout (that lives in GitHub Actions/Mergify, not git), and neither check name currently appears in any `.github/workflows/*.yml`, so 7 weeks on, either they've already been renamed/removed, or they were never revisited. There is no design anywhere for a general "pass-rate tracking mechanism" — that phrase is the retrospective's own synthesis, not a spec. Recommend re-deriving current flaky-check names from live CI re-run data before building anything, rather than building a system against a guessed spec.

## 6. `admin-bypass-sweep` STOP guard — structural gap, not a divergence

Checked all 30 replicated copies of `skills/admin-bypass-sweep/SKILL.md` across `~/.invoker/merge-clones/*` and `~/.claude/worktrees/*`: only 2 distinct file hashes exist, and **both retain the STOP section intact** — no copy has had the guard silently stripped.

The structural gap is different: the guard is prose only, enforced by an agent choosing to read and follow `SKILL.md` before running `gh pr merge --admin`. Nothing in this repo mechanically prevents a session with `gh` credentials from running `gh pr merge --admin --squash` directly, bypassing the skill file (and its slash-command + confirmation-sentence requirements) entirely — there is no wrapper, hook, or CI check around the underlying command itself, unlike (for example) how `diu-stop` backs a prose rule with a mechanical Stop-hook check in the `catstack` repo. Not fixed here — it's a design decision (wrap `gh pr merge --admin` itself, or accept the prose-only gate) for a human to make, not something to patch blind.

---

## What was actually changed in this pass

Nothing outside this doc — see the accompanying report for what was investigated vs. deliberately left undone.
