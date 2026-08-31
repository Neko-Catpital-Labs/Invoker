---
id: merge-gate
prove: pnpm --filter @invoker/app exec playwright test e2e/pending-review-gate-target-repo.proof.spec.ts
testids:
  - approve-merge-button
  - app-sidebar
---

# merge-gate

## Sub-features

- Merge gate node on the graph
- Approve / external review gate

## How to get to it (user POV)

Load a plan with onFinish pull_request; select the merge-gate task node.

## Driving it with control-invoker

```bash
node skills/verify/control-invoker.mjs prove merge-gate
```

## Gotchas

- visual-proof.spec.ts also has merge-gate capture cases.
