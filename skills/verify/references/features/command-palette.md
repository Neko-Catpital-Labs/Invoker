---
id: command-palette
prove: pnpm --filter @invoker/app exec playwright test e2e/command-palette-open.spec.ts
testids:
  - command-palette
  - app-sidebar
---

# command-palette

## Sub-features

- Open/close via Meta+K
- Jump to workflow/task/view

## How to get to it (user POV)

From any surface, press Cmd/Ctrl+K.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove command-palette
node skills/verify/control-invoker.mjs press --key Meta+K --dry-run
```

## Gotchas

- Assert data-state open/closed on `command-palette`, not just visibility.
