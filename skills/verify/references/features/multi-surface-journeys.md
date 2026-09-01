---
id: multi-surface-journeys
prove: pnpm --filter @invoker/app exec playwright test e2e/keyboard-navigation.spec.ts
testids:
  - app-sidebar
  - sidebar-home
  - sidebar-planning
  - sidebar-workflows
  - sidebar-attention
  - sidebar-workers
---

# multi-surface-journeys

## Sub-features

- Cross-surface keyboard/nav journeys
- Broad sweep ordering

## How to get to it (user POV)

Walk the README sweep order after a UI change that touches shared chrome.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove multi-surface-journeys
node skills/verify/control-invoker.mjs catalog --check
```

## Gotchas

- This file exists so catalog --check has a broad-sweep entry; expand prove as journeys grow.
