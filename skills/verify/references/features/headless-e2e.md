---
id: headless-e2e
prove: test -f scripts/e2e-dry-run/run-all.sh
testids:
  - app-sidebar
---

# headless-e2e

## Sub-features

- Headless Electron cases under scripts/e2e-dry-run
- proof-e2e.manifest suites

## How to get to it (user POV)

No UI window required; run from repo root.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove headless-e2e --dry-run
pnpm run test:e2e-dry-run
```

## Gotchas

- prove command here only checks the harness exists; full dry-run suite is long.
