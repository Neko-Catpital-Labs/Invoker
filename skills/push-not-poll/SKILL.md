---
name: push-not-poll
category: optimization
description: >
  Prefer a push/wait mechanism over a short-interval poll loop for any
  long-running wait inside a turn-based agent harness. Use when designing or
  reviewing a workflow step that waits on a background process, CI job, or
  other long-running task, since each poll turn resends the whole growing
  conversation and token cost compounds with turn count, not wall-clock time.
---

# push-not-poll

## Principle

In a turn-based agent harness, every turn resends the whole conversation so
far. A short-interval poll loop ("check every 10s") turns a single wait into
many turns, and each of those turns pays for the full, ever-growing
transcript again. Token cost compounds with turn count, not wall-clock time.

Prefer a mechanism that does not cost a conversational turn per check:

- A single blocking call with a generous timeout.
- A host-level callback or notification (push, not poll).
- If polling is unavoidable, a turn-based check with an interval sized to
  the real expected duration, plus a hard turn cap.

## Worked example: fix-ci auto-repair

The fix-ci auto-repair flow waits on a backgrounded CI verify command. Two
poll policies were measured against the same 45-minute wait with
`node scripts/fix-ci-token-bench.mjs --gate [--candidate baseline]`:

- 10s poll interval, no turn cap: 74,147,000 tokens.
- 180s poll interval, 15-turn cap: 966,000 tokens.

That is a 98.7% reduction for the same real wait. The 180s/15-turn policy
has been part of this repo's default check suite since PRs #11887-#11891
(merged 2026-09-03).

## See also

`corpus/skills/principle-push-not-poll` in `EdbertChan/catstack` is the
sibling, cross-project origin of this same principle.
