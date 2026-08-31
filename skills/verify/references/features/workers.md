---
id: workers
prove: pnpm --filter @invoker/app exec playwright test e2e/workers-surface.spec.ts
testids:
  - app-sidebar
  - sidebar-workers
---

# workers

## Sub-features

- Workers surface registration and activity
- Worker tab scroll

## How to get to it (user POV)

Library → Workers (`sidebar-workers`).

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove workers
```

## Gotchas

- workers-surface.spec.ts is the canonical registration proof.
