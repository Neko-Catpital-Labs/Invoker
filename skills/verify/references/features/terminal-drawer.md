---
id: terminal-drawer
prove: pnpm --filter @invoker/app exec playwright test e2e/embedded-terminal-pty.spec.ts
testids:
  - terminal-drawer
  - terminal-drawer-body
---

# terminal-drawer

## Sub-features

- Embedded PTY terminal
- Expand/collapse and tmux mode

## How to get to it (user POV)

Select a task that opens the terminal drawer.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove terminal-drawer
```

## Gotchas

- Many terminal garble repros exist; use the specific repro when proving a garble bug.
