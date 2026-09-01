---
description: Plan a change and submit it through Invoker
argument-hint: "help me plan <change>"
---

Use this host's native planning mode when the host supports entering it from this command. If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved.
Approval authorizes the reviewed plan's declared `onFinish` outcome. Generated implementation plans default to `onFinish: pull_request`, so approval includes pushing the prepared branch and creating or updating the GitHub PR/stack. `onFinish: none` publishes nothing; never exceed the reviewed outcome.
After submit, arm `invoker-cli wait <workflowId>` with notify_on_output on `^INVOKER_WAKE`, end the turn, and continue the parent job on wake (do not abandon the session).
Before branch or PR/stack publication implied by the reviewed `onFinish`, read and follow `skill://make-pr/SKILL.md`. This is the publication procedure, not a second authorization gate. If the plan involves multiple review slices, first read and follow `skill://review-compression/SKILL.md` before writing workflow YAML.


Write the planning artifact to `plans/invoker-handoff.md`.

Convert the approved Markdown plan to `plans/invoker-handoff.yaml`.

Freshness metadata is optional. When explicit freshness data is available, add it under the task's `freshness` object with `watchPaths`, `pathPreconditions`, and/or `guardedBehaviorIds`; omit it otherwise. Keep task descriptions as authored prose: structured metadata supplements the prose and does not replace or rewrite it. Do not derive freshness from task prose through post-generation extraction or a semantic regex.

```yaml
tasks:
  - id: implement
    description: Preserve this task prose.
    freshness:
      watchPaths: [packages/app/src]
      pathPreconditions: [{path: packages/app/src, expected: present}]
      guardedBehaviorIds: [plan-authoring]
```

Call `invoker_prepare_plan_review` on `plans/invoker-handoff.yaml`, show the returned ordered steps and `confirmationText`, and use that review output as the only approval gate.

Plain approval authorizes the reviewed `onFinish` outcome. After Invoker submission, park on `invoker-cli wait` rather than abandoning the session, then complete that outcome on wake.

If the review result says `confirmationMode` is `require`, wait for approval before submission. If it says `auto_submit`, show the same review output and then submit immediately.

Call `invoker_submit_plan` with mode `live` only after that review step, or immediately after it when `confirmationMode` is `auto_submit`.

If MCP tools are not available but `invoker-cli` is on PATH, mirror the same flow with `invoker-cli run plans/invoker-handoff.yaml --live` only after the review/approval step.
