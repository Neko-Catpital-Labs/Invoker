---
id: visual-proof-pr-path
prove: test -f scripts/ui-visual-proof.sh
testids:
  - app-sidebar
---

# visual-proof-pr-path

## Sub-features

- capture-before / capture-after / compare / embed / validate
- Merge-gate visual proof upload path

## How to get to it (user POV)

For UI-impacting PRs, capture before on base then after on the change.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs visual-proof validate --dry-run
node skills/verify/control-invoker.mjs prove visual-proof-pr-path
```

## Gotchas

- Capture alone is not proof — open media and write Manually inspected: (prove-it).
