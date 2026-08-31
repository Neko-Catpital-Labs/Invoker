---
name: maintain-verify
description: >
  Keep skills/verify/references/features in sync with sidebar testids, e2e specs,
  and repros. Use when adding UI surfaces, when catalog --check fails, or on a
  daily maintain-verification pass for Invoker.
---

# maintain-verify

Maintain the Invoker verification feature map so agents always have current
entry points and prove commands.

## Command

```bash
node skills/verify/control-invoker.mjs catalog --check --json
node skills/verify/control-invoker.mjs catalog --list
```

`--check` is the CI / `pnpm test` gate (via `scripts/test-verify-skill.sh`).

## When to run

- After adding a sidebar surface, modal, or `data-testid`
- After adding a Playwright e2e under `packages/app/e2e/`
- Daily / whenever verify prove commands feel stale
- When `catalog --check` fails

## Flow

1. Run `catalog --check` and read the error list.
2. For each missing required sidebar testid, add or update the feature file under
   `skills/verify/references/features/` with frontmatter `id`, `prove`, `testids`.
3. Point `prove:` at an **existing** Playwright spec, `scripts/repro/*`, e2e-dry-run
   case, or a cheap existence check — do not invent new heavy CI jobs.
4. Keep the four body headings: Sub-features, How to get to it (user POV),
   Driving it with control-invoker, Gotchas.
5. Update `references/features/README.md` sweep order when adding a file.
6. Re-run `catalog --check` until exit 0.
7. Re-run `bash scripts/test-verify-skill.sh`.

## Non-goals

- Do not rewrite product UI to satisfy the catalog.
- Do not attach to the user's open Electron window.
- Do not replace `skills/visual-proof` or `skills/prove-it`.
