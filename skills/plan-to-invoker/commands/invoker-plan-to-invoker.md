---
description: Plan a change and submit it through Invoker
argument-hint: "help me plan <change>"
---

Use this host's native planning mode when the host supports entering it from this command. If the host cannot be switched by this command, do a read-only planning pass and do not edit product code before the plan is approved.
If the request involves creating, updating, publishing, or splitting pull requests or PR stacks, first read and follow `skill://make-pr/SKILL.md` before PR authoring or publication. If it involves multiple review slices, first read and follow `skill://review-compression/SKILL.md` before writing workflow YAML.


Write the planning artifact to `plans/invoker-handoff.md`.

Convert the approved Markdown plan to `plans/invoker-handoff.yaml`.

Validate with `invoker_validate_plan` before submitting.

Submit with `invoker_submit_plan` using mode `live` so the workflow appears in the running Invoker app.

If MCP tools are not available but `invoker-cli` is on PATH, run `invoker-cli run plans/invoker-handoff.yaml --live` instead.
