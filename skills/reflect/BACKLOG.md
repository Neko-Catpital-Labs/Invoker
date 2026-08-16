# Reflect backlog

Durable tracker for findings that `reflect` routed to **Backlog**: real, evidence-backed,
but the right fix is a script/lint/enforcement mechanism, not more skill prose. `reflect`'s
own process (`skills/reflect/SKILL.md` step 4) never implements these — they wait here for a
human/maintainer to pick up as separate implementation work.

This file exists because Backlog items previously lived only as prose inside individual
reflect-task PR diffs, in isolated per-task worktrees with no shared visibility. A fix task
running the exact class-search this file's items were filed from could not discover that the
fix it was about to apply was already flagged as "don't just patch this again" — see the first
entry below, which was filed once, then the identical defect recurred a 4th time before this
file existed to catch it.

Before filing a new Backlog item, check here for an existing entry on the same defect class.
If found, append an occurrence line under it instead of creating an untracked duplicate.

---

## `.github/workflows/ci.yml`: `apt-get install` package lists have no single source of truth

**Status:** Backlog (open) — needs a maintainer decision on the canonical package set and which
jobs actually need which subset before a lint can be written safely.

**Symptom:** A CI job's dependency-install step is missing one system package (`unzip`,
`libatomic1`, `python3`, ...) that a different job's near-identical `apt-get install` line
already has. Each occurrence gets diagnosed and fixed correctly, one job at a time — but the
underlying gap (13+ independently-maintained `apt-get install` lines in one file, no shared
list) is never closed, so the same failure resurfaces in the next job that needs a package the
others already have.

**Proposed fix (not implemented):** Either (a) extend
`scripts/test-ci-workflow-merge-queue-policy.mjs` to enumerate every `run:` step containing
`apt-get install` for Node/native-build prerequisites and assert each installs a single
canonical baseline set, failing loudly on drift; or (b) extract one composite action (e.g.
`.github/actions/install-node-system-deps`) referenced by every job, so there is structurally
only one place left to patch. Note `c905a7007` (an unlanded sibling attempt on a related fix)
took a third approach — replacing `scripts/electron.cjs`'s `unzip`-based repair fallback with
`extract-zip` (already an Electron dependency) — which would eliminate the need for system
`unzip` in CI entirely for that specific symptom; worth weighing against (a)/(b).

**Occurrences (each independently diagnosed and merged, none referencing this file until now):**
- `ec4a30c54` / `daaa3bdaf` / `876f8bda1` — three one-tool-at-a-time patches to UI Vitest's
  install step within five hours (`libatomic1, make, g++, python3`, a `sudo -n` check, `unzip`).
- `090b10917` (#9326) — provisioned `unzip` for UI Vitest.
- `0d9d8d4ff` (#9352) — provisioned `unzip` for Docker Electron repair.
- `021e871c5`, `7d2e8535b`, `f46901b57`/`48356b0b0`, `c4266c18f` — further independent `unzip`
  provisioning commits across other jobs.
- First flagged as a systemic Backlog item by the `reflect` pass on workflow
  `wf-1786843012160-2` (`cd07355`-fleet, 14 jobs), transcript
  `~/.claude/projects/...-1786843012160-2-reflect-ci-cd07355-fleet-cd07355-14-jobs-.../c1b6b0a2....jsonl`:
  *"Consolidate the ~7 duplicate 'install unzip' blocks in `ci.yml` into one composite action,
  or add a lint that flags a new job re-installing a package already installed elsewhere in the
  file."* Not implemented at the time of filing.
- `cdb3239d3` (this workflow, `wf-1786860952000-7`, CI job `required-fast / Mergify Admin
  Requeue`) — added `unzip` to `required-fast-extra`'s line (ci.yml:584). The fix task ran the
  documented class-search, found the precedent commits above, cited them, and still only
  patched its own line — the standing backlog item above was invisible to it because it lived
  only in an unrelated PR's task-summary prose, not anywhere the class-search would surface it.

**Current non-compliance (verified against the working tree at the time this entry was filed;
re-check before assuming it's still accurate):** `grep -n "apt-get install"
.github/workflows/ci.yml` shows 13 lines with inconsistent package sets — e.g. line 43
(`build-artifacts`) has only `make g++`, missing `libatomic1`/`python3`/`unzip`; the newly
patched line 584 (`required-fast`) still lacks `python3`, which lines 196/202/377/657/871/952/
1030 all have; lines 377/657/871/952/1030 lack `libatomic1`. Only lines 196/202 currently carry
the full `libatomic1 make g++ python3 unzip` set.
