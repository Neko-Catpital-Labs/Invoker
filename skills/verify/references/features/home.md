---
id: home
prove: pnpm --filter @invoker/app exec playwright test e2e/keyboard-navigation.spec.ts
testids:
  - app-sidebar
  - sidebar-home
---

# home

## Sub-features

- Planning chats list on Home
- Theme toggle and settings rail

## How to get to it (user POV)

Click Invoker / Home in the left rail (`sidebar-home`).

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove home
node skills/verify/control-invoker.mjs click --testid sidebar-home --dry-run
```

## Gotchas

- Home shares the sidebar shell with other surfaces; assert `sidebar-home` aria-current when selected.
