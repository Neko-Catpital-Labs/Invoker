---
id: attention
prove: pnpm --filter @invoker/app exec playwright test e2e/attention-click-hitch-responsiveness.spec.ts
testids:
  - app-sidebar
  - sidebar-attention
---

# attention

## Sub-features

- Needs Attention list
- Attention click responsiveness

## How to get to it (user POV)

Library → Needs Attention (`sidebar-attention`).

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove attention
```

## Gotchas

- Hitch specs measure latency; they are still the dedicated attention surface proof.
