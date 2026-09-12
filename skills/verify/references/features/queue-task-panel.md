---
id: queue-task-panel
prove: pnpm --filter @invoker/app exec playwright test e2e/queue-running-vs-queued.spec.ts
testids:
  - queue-chip-running
  - queue-chip-queued
  - app-sidebar
---

# queue-task-panel

## Sub-features

- Action queue chips
- Running vs queued semantics
- Task panel command display

## How to get to it (user POV)

Open a workflow with running/queued tasks; queue chips sit in the status chrome.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove queue-task-panel
```

## Gotchas

- edit-task-command.spec.ts / edit-task-prompt.spec.ts cover panel edits.
