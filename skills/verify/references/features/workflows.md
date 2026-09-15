---
id: workflows
prove: pnpm --filter @invoker/app exec playwright test e2e/workflow-lifecycle.spec.ts
testids:
  - app-sidebar
  - sidebar-workflows
---

# workflows

## Sub-features

- Workflow list / browser
- Workflow status composition

## How to get to it (user POV)

Library → Workflows (`sidebar-workflows`).

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove workflows
```

## Gotchas

- Sibling: workflow-status-composition.spec.ts for chip/status claims.
