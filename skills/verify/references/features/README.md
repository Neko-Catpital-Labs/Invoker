# Feature map

Behavior inventory for `control-invoker` / `invoker-verify`.

Each `*.md` file (except this README) has YAML frontmatter:

- `id` — feature id for `prove <id>`
- `prove` — deterministic shell command (Playwright spec, repro, or owner query)
- `testids` — `data-testid` values this surface owns

Body headings (required):

1. Sub-features
2. How to get to it (user POV)
3. Driving it with control-invoker
4. Gotchas

## Sweep order

For broad regression, walk top to bottom then finish with `multi-surface-journeys.md`:

1. home
2. plan-graph
3. workflows
4. attention
5. workers
6. command-palette
7. system-setup
8. queue-task-panel
9. terminal-drawer
10. merge-gate
11. history-timeline
12. modals
13. owner-api-live-path
14. headless-e2e
15. visual-proof-pr-path
16. multi-surface-journeys

## Maintain

```bash
node skills/verify/control-invoker.mjs catalog --check
```

See `skills/maintain-verify/SKILL.md`.
