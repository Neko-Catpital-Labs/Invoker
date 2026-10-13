---
id: history-timeline
prove: pnpm --filter @invoker/app exec playwright test e2e/ui-delta-timeline.spec.ts
testids:
  - timeline-view
  - history-view
---

# history-timeline

## Sub-features

- Timeline view (workers/tasks modes)
- History task list

## How to get to it (user POV)

Open timeline/history from the UI chrome for a selected workflow.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove history-timeline
```

## Gotchas

- history-view and timeline-view are sibling surfaces; prove the one you changed.
