---
name: review-compression
description: >
  Shape code changes, workflow plans, and PR stacks so each diff is easy to
  review: one local claim, one safety invariant, clear architectural effect,
  and an explicit reason for the slice.
---

# review-compression

Use this skill before authoring implementation workflows, PR stacks, or any
multi-diff plan. Optimize for reviewer cognition, not smallest total patch.

## Core Rule

Each diff or workflow should make one locally reviewable claim. A tired senior
engineer should be able to answer:

- What architectural thing changed?
- Why does this slice exist?
- Why is it safe?
- What alternatives were rejected?

## Required Metadata

Every implementation slice should carry these fields in task descriptions and
PR bodies:

- `Review claim:` one sentence the reviewer is being asked to approve.
- `Review lane:` exactly one of `behavior`, `refactor`, `proof`, `cleanup`,
  `policy`, or `docs`.
- `Safety invariant:` why this slice is safe to review locally.
- `Slice rationale:` why this work is split here instead of bundled elsewhere.
- `Architectural effect:` what changed in control flow, data flow, ownership,
  dependency direction, or public surface.
- `Alternative considerations:` rejected designs or split shapes.
- `Non-goals:` what this slice explicitly does not change.

For mechanical slices, these can be terse. For cross-boundary changes, explain
the before/after architecture and why the split is acceptable.

## Ordering Rules

- Evidence before change: add repros, benchmarks, or instrumentation before the
  fix when they prove the problem.
- Refactor before behavior when the extraction is reusable and behavior-neutral.
- Foundation before behavior: add schemas, types, helpers, migrations, flags,
  and dormant code before behavior changes.
- Compatibility before exposure: include adapters with a lower-level change
  when needed to preserve existing behavior.
- Behavior before cleanup: fix correctness or security first; rename and cleanup
  later.
- Activate one surface or path per diff.
- Delete after migration, in a separate deletion slice as soon as safely unused.

## Boundary Rules

Split across architectural boundaries unless the downstream edit is required to
preserve existing behavior.

Common boundaries:

- DB migration, write path, read/API exposure, UI use, old column deletion.
- Core behavior, API exposure, UI behavior.
- Contract, handler, UI.
- CLI, API, UI.
- Mechanical rename, module reorganization.
- Helper extraction, usage migrations.

Exception: directly affected tests and compatibility adapters stay with the
change that requires them. Unrelated test stabilization and optional cleanup are
separate slices.

## Grouping Rules

Group changes only when they share the same review claim:

- generated output with the source schema change
- docs explaining the changed behavior, API, or default
- visual proof with the UI behavior change
- dependency bump with required adaptation
- exact same mechanical migration across many files
- pure repo-wide import-path rename

Split changes when they introduce a different claim:

- optional cleanup
- special cases inside a mechanical migration
- stale unrelated screenshots
- behavior fix plus rename
- default flip plus dead-path removal
- refactor/extraction plus new fields or other behavior changes
- benchmark/repro/proof harness plus the fix it is meant to justify
- product code plus planning/policy/docs updates
- broad mechanical moves too large to inspect comfortably

## PR Body Guidance

Do not summarize the patch file-by-file. Compress the human judgment:

- state the review claim
- state the safety invariant
- describe architectural effect in plain English
- call out why this slice exists
- include alternatives for non-obvious or cross-boundary choices

