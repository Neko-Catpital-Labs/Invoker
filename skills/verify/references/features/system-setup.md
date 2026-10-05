---
id: system-setup
prove: pnpm --filter @invoker/app exec playwright test e2e/system-setup-visual-proof.spec.ts
testids:
  - rail-settings
  - app-sidebar
---

# system-setup

## Sub-features

- System setup / settings modal
- Bundled skills install UI

## How to get to it (user POV)

Click Settings (`rail-settings`) in the left rail footer.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove system-setup
```

## Gotchas

- onboarding-cli-visual-proof.spec.ts covers CLI onboarding visuals, not the modal.
