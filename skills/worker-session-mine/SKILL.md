---
name: worker-session-mine
description: >
  Invoker-owned adapter for the off-by-default worker-session-mine owner worker.
  Mines terminal fire-and-forget agent sessions (Claude, Codex, OMP) for mechanical
  thrash and files a separate Invoker follow-up. Toggle via Workers UI / worker
  desired-state. Do not use for interactive /reflect — that stays in catstack.
---

# worker-session-mine

## Hard rules

- Never vendor catstack `reflect` into this repo as `skills/reflect/`.
- Never stop or cancel the original repair/workflow the session came from.
- Never merge follow-up PRs.
- Worker kind `worker-session-mine` must stay off `ALWAYS_AUTO_STARTED_OWNER_WORKER_KINDS`.
- Cap: one follow-up per session hash per week; max 1 per tick and 2 per day.
- Multi-harness: discovers via Invoker task inventory (`agentSessionId` + `agentName`), resolves Claude (`CLAUDE_CONFIG_DIR` / `~/.invoker/claude-worker/projects`), Codex (`~/.invoker/agent-sessions/*.jsonl`), OMP (`*.omp.txt`).

## Enable (UI / CLI)

1. Clone catstack to `$HOME/catstack` (optional `token_audit.py`); set `CATSTACK_ROOT`.
2. Enable desired-state for `worker-session-mine` on the DO1 owner:
   - Workers UI → Enable, or
   - `invoker-cli worker toggles --enable worker-session-mine`
3. Do not enable on Mac owners by default.

## Follow-up routing

| Finding type | Destination |
|---|---|
| Skill prose / methodology / hooks | **catstack** PR only |
| Invoker harness prompt / product | **Invoker** PR only |

## Detector

`scripts/worker-session-mine-thrash.mjs` — thrash if any of assistant/Codex turns >= 40, cache_read >= 10M, same bash argv >= 5, or catstack `token_audit.py` flags when `CATSTACK_ROOT` is set.

Self-test: `node scripts/worker-session-mine-thrash.mjs --self-test`
Resolve self-test: `node scripts/worker-session-mine-resolve.selftest.mjs`
