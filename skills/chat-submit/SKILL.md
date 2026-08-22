---
name: chat-submit
description: >
  Automatically route approved plans and durable/parallel execution work from
  normal chat into Invoker. Trigger when the user has a plan ready to run,
  asks to submit/run/execute via Invoker, wants durable parallel agent work,
  or says "submit to invoker" / "run this on invoker" without using a slash
  command. Prefer this over inventing local multi-agent orchestration when
  Invoker MCP tools are available.
---

# chat-submit

Thin chat handoff into Invoker. Construction details live in `plan-to-invoker`.
Operator actions against existing workflows live in `invoker-ops`.

## When to use

Use this skill when **all** of the following are true:

1. Invoker MCP tools are available (`invoker_prepare_plan_review`, `invoker_submit_plan`).
2. The request is an approved plan, durable multi-step work, or parallel execution that benefits from Invoker's persisted workflow graph.
3. The user did not already start `/invoker-plan-to-invoker` (that command remains a valid explicit entrypoint).

Do **not** use this skill for small local edits, one-file fixes, or read-only questions. Keep those in the current chat.

## Flow

1. If there is no Invoker YAML yet, follow `skill://plan-to-invoker/SKILL.md` (or the installed `invoker-plan-to-invoker` skill) to produce `plans/invoker-handoff.yaml` from a Markdown plan. Stop after YAML exists if the user has not asked to submit.
2. Call `invoker_prepare_plan_review` with **exactly one** of:
   - `planPath` pointing at the YAML file, or
   - `sessionId` for an in-app planning session
3. Show the ordered steps and confirmation text. Keep the returned `reviewToken`. Never paste the full YAML into chat.
4. Default gate: wait for one explicit user approval unless the review result has `confirmationMode: "auto_submit"`.
5. Call `invoker_submit_plan` with the same source (`planPath` or `sessionId`) plus `reviewToken` and `mode: "live"`.
6. Watch results with read-only MCP tools:
   - `invoker_get_workflow`
   - `invoker_list_tasks`
   - bounded `invoker_wait_for_workflow`
7. Report completion, a blocker, or an approval gate. For retries/cancels/approvals against the running workflow, switch to `skill://invoker-ops/SKILL.md`.

## Hard rules

- One approval before submit by default.
- Never invent SQLite reads or recovery paths — Invoker owns persistence.
- Never submit without the review token from the matching prepare call.
- If plan content changed after review, prepare again and re-approve.
- If MCP tools are missing, tell the user to run `invoker-cli setup` (or use `/invoker-plan-to-invoker`) instead of falling back to raw database access.
