---
id: plan-graph
prove: pnpm --filter @invoker/app exec playwright test e2e/visual-proof.spec.ts
testids:
  - app-sidebar
  - sidebar-planning
---

# plan-graph

## Sub-features

- Plan / workflow graph (React Flow)
- Task nodes and selection

## How to get to it (user POV)

Click Plan graph (`sidebar-planning`) after a plan is loaded.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove plan-graph
```

## Gotchas

- Full visual-proof.spec.ts is heavy; prefer a focused spec when proving a single graph bug.
