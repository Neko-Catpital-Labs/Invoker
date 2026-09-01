---
description: Plan a change and submit it through Invoker
argument-hint: "help me plan <change>"
---

Use this host's native planning mode when the host supports entering it from this command. If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved.
Plain approval authorizes workflow handoff only: submit the approved workflow and do not publish local branches, create PRs, or update PR stacks unless the user explicitly asks for PR publication.
After submit, arm `invoker-cli wait <workflowId>` with notify_on_output on `^INVOKER_WAKE`, end the turn, and continue the parent job on wake (do not abandon the session).
If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow `skill://make-pr/SKILL.md` before PR authoring or publication. If it involves multiple review slices, first read and follow `skill://review-compression/SKILL.md` before writing workflow YAML.


Write the planning artifact to `plans/invoker-handoff.md`.

Convert the approved Markdown plan to `plans/invoker-handoff.yaml`.

Call `invoker_prepare_plan_review` on `plans/invoker-handoff.yaml`, show the returned ordered steps and `confirmationText`, and use that review output as the only approval gate.

Plain approval means workflow handoff only: do not publish a local branch or create, update, or publish a PR unless the user explicitly asks for PR publication. After Invoker submission, park on `invoker-cli wait` rather than abandoning the session.

If the review result says `confirmationMode` is `require`, wait for approval before submission. If it says `auto_submit`, show the same review output and then submit immediately.

Call `invoker_submit_plan` with mode `live` only after that review step, or immediately after it when `confirmationMode` is `auto_submit`.

If MCP tools are not available but `invoker-cli` is on PATH, mirror the same flow with `invoker-cli run plans/invoker-handoff.yaml --live` only after the review/approval step.
