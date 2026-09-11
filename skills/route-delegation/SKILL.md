---
name: route-delegation
description: >
  Decide between a subagent swarm and an Invoker submission before fanning
  out. Trigger when about to spawn several subagents, forks, background
  agents, or a multi-agent workflow, and always when any unit would make a
  commit, a PR, a tag, a merge, or a deploy. Publishing work goes to Invoker
  when its MCP tools are available; only read-only, report-only work fans out
  to subagents. Separable and parallel decide nothing on their own.
---

# route-delegation

Ask one question before fanning out: **what does each unit produce?**
Being separable or parallel is not a reason to fan out. The output decides.

Handoff mechanics live in `skill://chat-submit/SKILL.md`. YAML construction
lives in `skill://plan-to-invoker/SKILL.md`. This skill only picks the road.

## Decide

1. **Name every unit's output.** Allowed names:
   - publishing: `commit`, `pull_request`, `tag`, `merge`, `deploy`, `durable_artifact`
   - not publishing: `none`, `report`, `research`, `review`, `verification`

   No output named, or a name not on this list: stop and name it. An output
   nobody declared is unchecked, not clean.
2. **Some work publishes no matter what it says it produces:** an approved
   plan, a post-land babysit (wait until `MERGED`, merge-queue watching), and
   an already-named execution backlog.
3. **Nothing publishes → subagent fan-out.** Spawn worktree-isolated
   subagents, collect reports async, and grep each transcript for writes or
   commits before trusting its summary.
4. **Something publishes → never a subagent swarm.**
   - Invoker MCP (`invoker_prepare_plan_review` and `invoker_submit_plan`)
     missing: stay local — the parent session does it in its own worktree.
   - One-slice, one-file, or read-only work: stay local in this chat.
   - Approved plan, or durable/parallel work: submit to Invoker through
     `skill://chat-submit/SKILL.md`.

Executable form, same table:

```bash
node skills/route-delegation/scripts/route-delegation.mjs '{"tools":["invoker_prepare_plan_review","invoker_submit_plan"],"work_kind":"durable_parallel","produces":["commit","pull_request"]}'
```

It prints `{"route": ..., "steps": [...]}` where `route` is one of
`local`, `delegate_invoker`, or `subagent_fanout`, and exits non-zero on an
undeclared output or an unknown work kind.

## Why

A swarm that commits works outside Invoker's task graph: no persisted plan,
no retries, no merge gate, no single reviewed approval, and nothing to
resume after the chat ends. The failure this skill exists for: eight
subagents spawned because the work was "separable, default to parallel",
each producing a PR-worthy commit, with `invoker-cli` installed and the
routing rule never consulted. Nothing in a fan-out default said no, because
nothing in it was ever about publishing.

Prior art: least privilege. Saltzer and Schroeder, "Basic Principles of
Information Protection" (1975),
https://web.mit.edu/Saltzer/www/publications/protection/Basic.html — base
access on permission rather than exclusion. A default about saving context
is not a grant of publishing authority.

## Other harnesses

Personal or harness-agnostic configs that carry their own delegation table
should defer to this skill when it is installed (as
`invoker-route-delegation`) and keep their own table only as the fallback.
