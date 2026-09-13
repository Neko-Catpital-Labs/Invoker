---
id: owner-api-live-path
prove: test -x invoker-ctl && ./invoker-ctl --help | grep -q health
testids:
  - app-sidebar
---

# owner-api-live-path

## Sub-features

- HTTP API on localhost:4100
- invoker-ctl health/status/workflows
- invoker-cli query workflows|tasks

## How to get to it (user POV)

Start an owner (`invoker-cli owner serve` or the desktop app), then query.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs owner health --dry-run
node skills/verify/control-invoker.mjs owner query workflows --dry-run
```

## Gotchas

- Live-path claims need a running owner; dry-run only prints the command.
