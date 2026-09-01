---
name: verify
description: >
  Drive and prove Invoker UI/live-path changes via skills/verify/control-invoker.mjs:
  doctor, feature-map prove commands, isolated-Electron drive, visual-proof wrap,
  and owner query. Use for Invoker UI claims, before asserting done/shipped, or when
  the user asks to verify / control-invoker / prove a surface.
---

# verify

Project-local verification skill for the Invoker desktop app. Agents close their
own loop by running existing Playwright specs, repros, visual-proof capture, and
live-owner queries — not by asking the human to look.

Keep using `skills/prove-it/SKILL.md` for the evidence gate (open media this turn;
prefix `UNVERIFIED:` when you did not). This skill picks **which command** to run.

## CLI

```bash
node skills/verify/control-invoker.mjs --help
node skills/verify/control-invoker.mjs doctor --json
node skills/verify/control-invoker.mjs prove command-palette --dry-run --json
node skills/verify/control-invoker.mjs prove command-palette
node skills/verify/control-invoker.mjs catalog --check
node skills/verify/control-invoker.mjs visual-proof validate --dry-run
node skills/verify/control-invoker.mjs owner query workflows --dry-run
node skills/verify/control-invoker.mjs screenshot --out /tmp/invoker-proof.png --dry-run
```

JSON out (`--json`), rich `--help`, and `--dry-run` on destructive owner actions
are required. Drive commands launch an isolated Electron build — never attach to the user's already-open window.

## Flow

1. Match the change to a file under `references/features/`.
2. Run `doctor` (fail closed on stale UI/app builds).
3. Run `prove <feature>` (or drive + screenshot for a one-off path).
4. For PR pixels, use `visual-proof capture-before|capture-after` (wraps `scripts/ui-visual-proof.sh`).
5. For live owner state, use `owner query …` / `owner health` (wraps `invoker-cli` / `invoker-ctl`).
6. Before claiming done: follow prove-it — open screenshots/video yourself, or cite fresh query output.

## Feature map

`references/features/` — one markdown file per surface. Frontmatter:

```yaml
---
id: command-palette
prove: pnpm --filter @invoker/app exec playwright test e2e/command-palette-open.spec.ts
testids:
  - command-palette
  - app-sidebar
---
```

Body uses the four headings: Sub-features, How to get to it (user POV), Driving
it with control-invoker, Gotchas.

Maintain drift with `skills/maintain-verify/SKILL.md` and `catalog --check`.

## Efficacy fixtures

Under `tests/`:

- `fires_example.md` — UI claim that must load verify and run `prove <feature>`
- `stays_silent_example.md` — non-UI change that must not use control-invoker
- `efficacy-router.test.mjs` — asserts known prompts map to the right prove command

Run: `bash scripts/test-verify-skill.sh`

## Non-goals

- Do not rewrite Playwright specs or `scripts/repro/*`.
- Do not attach CDP to the user's live desktop session.
- Do not replace merge-gate visual-proof capture in the task runner.
