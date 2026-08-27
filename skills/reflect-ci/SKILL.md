---
name: reflect-ci
description: >
  Invoker-owned adapter for automated reflect-ci-* / autofix-miss tasks filed by
  the optional CI regression watcher (INVOKER_CI_REGRESSION_REFLECT=1). Use when
  running reflect-ci-<job-slug> tasks, mining fix-ci transcripts for durable
  methodology misses, or emitting REFLECT_CI_AUTOFIX_MISS operator logs. Do not
  use for ordinary human-driven /reflect — that stays in catstack's reflect skill.
---

# reflect-ci

Invoker integration skill. Generic transcript mining and skill-edit approval stay in catstack's `reflect`. This skill only owns the automated CI autofix-miss path.

## When to use

- The task id/name matches `reflect-ci-*`
- `INVOKER_CI_REGRESSION_REFLECT=1` filed the workflow
- The job depends on `fix-ci` (not only green `verify-ci`)

## Process

1. Prefer this workflow's **fix-ci** agent transcript. Do not wait for verify green.
2. Corroborate outcome against Invoker task status / summary / `git log`.
3. Classify **autofix-miss** when any of:
   - Wrong package/surface edited
   - Partial suite green treated as done
   - No dedicated repro before product edits
   - Sibling PR / nearby failure treated as root cause without failing-then-passing proof
   - Agent claimed success while `needsHuman`, verify failed, or acceptance criteria incomplete
4. Route Accepted findings:
   - Methodology about Invoker-owned skills → Invoker PR against `skills/` (never merge from the task)
   - Catstack-owned or personal-mode methodology → catstack PR. Never vendor `skills/reflect/` into Invoker
   - Mechanical harness prompt/logging only → Invoker PR
5. For automated `reflect-ci-*` only: treat the task prompt Acceptance criteria as pre-approval for drafting/opening PRs, not merging. Uncertain findings go to Backlog.
6. Before exit, append operator logs:

```bash
mkdir -p "${INVOKER_REFLECT_CI_LOG_DIR:-$HOME/.invoker/reflect-ci}"
# Prefer scripts/reflect-ci-log.mjs when present on HEAD.
echo "REFLECT_CI_AUTOFIX_MISS outcome=<autofix_miss|success_path|no_durable_finding> job=<slug>"
```

Paste the marker line into the task summary.

## Summary extras

- Autofix-miss: yes/no + one-line evidence
- Targets updated: catstack / invoker-harness / none
- Log: confirm `REFLECT_CI_AUTOFIX_MISS` emitted

## Hard rules

- Never vendor catstack `reflect` into this repo as `skills/reflect/`.
- Never drive-by product or unrelated CI-job fixes from this skill.
- Prefer structural gates (tests, scripts, harness prompts) over prose.

## Related: worker-session-mine

Fire-and-forget Invoker worker Claude sessions (`claude -p`) are mined by the
off-by-default `worker-session-mine` owner worker — see
`skills/worker-session-mine/SKILL.md`. That path files a separate follow-up and
may open an **Invoker** PR when the root cause is harness/product (unlike
typical `reflect-ci-*` tasks, which stay catstack-only for methodology). Do not
confuse the two.
