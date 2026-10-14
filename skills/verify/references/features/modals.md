---
id: modals
prove: pnpm --filter @invoker/app exec playwright test e2e/fix-with-agent-transition.spec.ts
testids:
  - app-sidebar
---

# modals

## Sub-features

- Approval / input / replace-task modals
- Agent transition overlays

## How to get to it (user POV)

Trigger the modal via the task action that opens it (approve, needs_input, replace).

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove modals
```

## Gotchas

- Prefer a focused modal spec when one exists for the exact dialog.
