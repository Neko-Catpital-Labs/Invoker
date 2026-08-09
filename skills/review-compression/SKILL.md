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
the before/after architecture and why the split is acceptable. Each slice must
still contain one conceptual unit; validators infer mixed units from the claim,
rationale, implementation details, and change-type entries.

## Safety Invariant Confirmation

Before finalizing an implementation plan, Invoker YAML, or PR stack, propose
the `Safety invariant:` for every slice and ask the user to confirm or correct
it. Keep the existing heading and definition: it explains why the slice is safe
to review locally. Mechanical slices may use terse invariants, but they still
require user confirmation.

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
  Exception: a pure rehome/relocation of an already-cohesive unit (no
  decomposition) deletes the old path in the SAME slice as the move — see
  Rehome / Relocation Refactors.

## Proof Must Match the Claim

A `proof` slice (repro, regression test, benchmark) exists to demonstrate one specific claim. Before writing it, name the exact property the bug report or Review Claim describes, then check the assertion tests that literal property — not a nearby signal that is easier to check but proves a different thing. "The panel stayed visible" is not evidence for "the camera did not move"; "the request returned 200" is not evidence for "the record was written correctly." A proxy assertion can pass while the real behavior described in the claim is still broken, which lets a broken fix ship as proven.

When authoring or reviewing a `proof` slice, ask: if I only read this assertion's name and expect, would I know it tests the same thing the Review Claim states? If not, rewrite the assertion against the literal property, even if that property is harder to check. See `skills/prove-it/SKILL.md` for the same rule applied to PR bodies and live system claims, not just tests.

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
- multiple distinct extractions from one file (one top-level symbol move per slice)

## Decomposition & Extraction Refactors

This section covers decomposition only: splitting ONE file's symbols across
multiple NEW modules. If the work is instead relocating an already-cohesive,
self-contained unit (a whole file, or a whole package/directory that is not
being split further) to a new location with the content materially
unchanged, skip to **Rehome / Relocation Refactors** below. Sequencing a pure
move the way this section sequences decomposition creates a long-lived
duplicate-logic drift window — see that section's rationale.

When you split a large file by extracting units into new modules, do one
refactor at a time: one PR moves exactly ONE top-level symbol. A function move
is its own PR. A class moves as one PR with its methods riding along — one
top-level symbol per PR, not method-by-method. Create the target file, move
that one symbol, re-point its references in the same PR so behavior is
preserved, and keep the public surface (facade, exports, dispatcher) stable. Do
not batch several distinct extractions into one diff.

Each move is a separate review claim. Every extraction has its own seam and its
own "is behavior preserved?" question, so the reviewer checks one move at a
time. "Extract prepare + dispatch + finalize" is three moves, three claims,
three slices — not one.

This does NOT contradict grouping the "exact same mechanical migration across
many files." That rule is one transformation applied to N call sites (one
claim). Decomposition is N distinct transformations (N claims): different code,
different seams, different risk.

Dependency-cluster exception: if the moved symbol depends on a private helper in
the same file that is not part of the public surface, and moving the symbol
alone would break the build or force a throwaway re-export shim, move that
minimal helper cluster together in the same PR. Keep the cluster as small as the
build requires — this is still one cohesive move, not a licence to batch
unrelated extractions.

Slice shape for one move:

- `Review claim:` "Move <unit> out of <file> into <new module>, behavior
  unchanged."
- create the new module and move exactly one top-level symbol into it
- update imports/facade in the same PR so the public surface is byte-for-byte
  identical to callers
- keep directly affected tests with the move; they prove behavior is preserved
- no behavior change in a move slice (Fowler's "two hats": never refactor and
  change behavior in the same diff)

Sequence the decomposition stack as:

1. one slice per extracted unit (create-and-move), foundational unit first
2. re-point remaining callers once a unit is extracted
3. delete now-dead original code in its own slice, as soon as it is unused

Grounding: Fowler, *Refactoring* — "Move Function" applied as small
behavior-preserving steps (compile-test-commit each); Beck, *Tidy First?* —
keep structural changes isolated from behavioral ones, each in its own
PR/commit; industry guidance (Graphite, Artsy) — one module/class per PR keeps
diffs near the 50–200 line review sweet spot.

## Rehome / Relocation Refactors

A rehome moves an already-cohesive unit — a whole file, or a whole
package/directory that is not being split further — to a new location with
its content materially unchanged: no new modules are created, no symbol is
split out, and the change is git-mv-shaped (`git diff --stat` renders as a
rename, not an unrelated add+delete pair). This is a different job from
Decomposition & Extraction Refactors above: decomposition is N distinct
transformations (N claims, N seams); a rehome is exactly ONE transformation
(the location). Treating a rehome as a decomposition stack — copy now,
repoint later, delete much later in a disconnected slice — is a
misapplication of that guidance, not a smaller version of it.

### Is it a rehome or a decomposition?

Rehome (this section) when ALL of:

- the moved unit keeps its existing internal structure; no top-level symbol
  is being extracted into a module that didn't exist before
- `git mv <old path> <new path>` (or the directory equivalent) produces the
  diff — content is byte-for-byte identical apart from import-path fixups
- exactly one new home is created, not several

Decomposition (previous section) when ANY of:

- the file's symbols are being split across two or more new modules
- the move changes internal structure (function/class boundaries) beyond
  import-path updates
- there is no single git-mv-shaped diff that captures the change — the
  change is inherently a rewrite, not a move

### Core rule: land the move as one slice, not copy-then-delete-later

Decomposition's `create → repoint → delete` sequence is safe because each
step reviews a genuinely different transformation. A rehome has no such
internal seam — the code itself hasn't changed, only its address. Splitting
a rehome the same way creates two independently-editable copies of the same
logic with only one of them live. If anyone hotfixes the old copy before the
deletion slice lands, that fix is invisible in the new copy and is silently
discarded when the old copy is later deleted — nothing re-diffs the two
copies before deletion.

Land the rehome as close to atomically as possible:

- **Preferred:** add the new path and delete the old path in the SAME
  PR/slice — a git-mv-shaped diff. Only deviate from this when the diff is
  provably too large to review in one slice.
- If repointing every caller in the same PR is genuinely too large, do not
  leave the old path as an independently-maintained duplicate. Land the move
  plus a thin forwarding shim at the old path in that same slice: the old
  path re-exports/delegates to the new path, so there is only ever ONE
  source of truth for the logic even though there are temporarily two
  importable paths. Repoint callers in following slices; delete the shim
  once the last caller is repointed, in its own final slice — that deletion
  removes only dead re-export plumbing, never live logic.

Slice shape for one rehome:

- `Review claim:` "Move <unit> from <old path> to <new path>; no logic
  change." (or, with a shim: "Move <unit> to <new path> and leave a
  forwarding shim at <old path>; no logic change.")
- git-mv-shaped diff: add at the new path, delete at the old path, in the
  same slice — or, when callers can't all move at once, add at the new path
  and replace the old path's body with a forwarding shim (re-export/delegate
  only, never duplicated logic) in the same slice
- update the moved unit's own internal imports so it is self-contained at
  the new path
- no logic change in a move slice (Fowler's "two hats" applies here too: a
  move is not the place to also fix a bug or add a field)
- keep directly affected tests with the move
- a shim-removal slice depends only on the callers-repointed slice(s), not
  unrelated work, and lands as soon as the last caller is repointed

Sequence a rehome stack as:

1. one slice: move the unit (git-mv-shaped) and, only if the full caller set
   cannot be repointed in the same slice, leave a forwarding shim at the old
   path in that SAME slice — never leave the old path holding
   independently-maintained live logic
2. re-point callers across following slices; the shim keeps them working
   meanwhile
3. delete the shim in its own slice once the last caller is repointed — this
   deletes only re-export plumbing, so there is nothing to lose

Contrast with the Decomposition sequence above: there, step 3 deletes the
OLD, LIVE implementation — safe only because each extracted unit was
reviewed as its own transformation first. In a rehome nothing has changed
except location, so retiring the original must not be deferred past the
slice that repoints its last caller.

Repo-specific gotcha: `scripts/review-unit-rules.mjs` classifies paths by
directory convention (for example `scripts/**` as `tooling-policy`), and
`validateReviewUnitChangedFiles` (wired into `scripts/validate-pr-body.mjs`)
rejects a PR whose changed files span more than the declared Review Unit.
When rehoming a file whose old path has a classification, declare the
Review Unit that matches the OLD path (commonly `tooling-policy` / Review
lane `policy` for `scripts/**`) unless the new path is independently
classified the same way — check `classifyReviewUnitsForPath` for both paths
before authoring the PR body.

Grounding: Fowler, *Refactoring* — "Move File"/"Rename" are catalogued as
trivial, tool-supported, behavior-preserving moves, distinct from "Extract
Function"/"Extract Class" (decomposition); Fowler / Newman — Branch by
Abstraction and the Strangler Fig pattern, where a stable seam (the shim)
sits in front of code being relocated so there is exactly one live
implementation at all times, even mid-migration; Beck, *Tidy First?* — a
move commits no behavior change, so it should not straddle a window where
the moved thing has two independently-editable homes.

## Naming the Technique

The two sections above are both instances of a single Fowler technique,
repeated: Decomposition & Extraction is "Move Function"/"Extract Class"
applied file-by-file; Rehome / Relocation is "Move File"/"Rename" applied
directory-by-directory. Neither section restates the technique's name because
each already gives it a full slice-shape treatment. This section covers the
rest of the catalog and states the naming rule that applies to all of them,
including the two above.

### Rule: name the technique

Every `refactor`-lane PR title or commit message states which single named
technique it applies, in the form `<Technique>: <what moved/changed>` — for
example `Move Method: git primitives -> repair_body.py`, `Extract Variable:
queue-only guard`, `Replace Conditional with Polymorphism: RepairOutcome
status dispatch`. The PR body's `## Review Claim` restates the same
technique by name. A vague claim like "clean up the repair module" is not
acceptable in a `refactor`-lane PR; name the technique or split further
until one name covers the whole slice.

This is not decoration: naming the technique is what lets a reviewer bring
the technique's own well-known safety properties to the review ("Extract
Variable never changes behavior by construction; I only need to check the
extracted expression is identical") instead of re-deriving correctness from
scratch for every diff.

### Technique catalog

Grouped by Fowler/refactoring.guru category. Not exhaustive — pick the
closest named technique; if none fits, say so explicitly in `## Review
Claim` rather than picking the nearest wrong name.

- **Composing Methods** — Extract Method, Inline Method, Extract Variable,
  Inline Variable, Replace Temp with Query, Split Loop, Slide Statements.
- **Moving Features Between Objects** — Move Method (this repo's
  Decomposition & Extraction section), Move Field, Move File (this repo's
  Rehome / Relocation section), Extract Class, Inline Class, Hide
  Delegate, Remove Middle Man.
- **Simplifying Conditional Expressions** — Decompose Conditional,
  Consolidate Conditional Expression, Replace Nested Conditional with Guard
  Clauses, Replace Conditional with Polymorphism, Introduce Null Object.
- **Simplifying Method Calls** — Rename Method, Add/Remove Parameter,
  Separate Query from Modifier, Parameterize Method, Replace Parameter with
  Explicit Methods, Preserve Whole Object, Replace Error Code with
  Exception.
- **Organizing Data** — Replace Magic Number with Symbolic Constant,
  Encapsulate Field, Replace Type Code with Class/Subclasses, Replace Array
  with Object, Change Value to Reference (and back).
- **Dealing with Generalization** — Pull Up/Push Down Method or Field,
  Extract Interface, Collapse Hierarchy, Form Template Method, Replace
  Inheritance with Delegation (and back).

### Prohibitions

- Never extract a function or class purely to make it independently
  testable. If the only justification is "now I can unit test this," the
  extraction is not earning its own review claim — either the behavior
  change that actually needs the test coverage justifies the extraction, or
  it doesn't belong in this slice.
- Never bundle a structural change with a behavioral one in the same diff.
  This restates Fowler's "two hats" (already stated per-section above) as a
  blanket rule across every technique in the catalog, not just Move
  Function/Move File: if you notice a real bug while renaming a method,
  finish the rename, land it, then fix the bug as its own `behavior`-lane
  slice.
- Verify the affected tests stay green after each step before moving to the
  next slice in a decomposition or rehome stack. A stack where slice 3
  breaks slice 1's tests is not a stack of independently-reviewable claims
  anymore — it's one change artificially spread across three PRs.

Grounding: Fowler, *Refactoring, 2nd ed.* (the six-category catalog this
section condenses); refactoring.guru/refactoring/techniques (the same
catalog with runnable before/after examples per technique); citypaul's
`refactoring` Claude Code skill (the testability and two-hats prohibitions
above, adapted to this repo's PR-per-slice model instead of a single local
commit sequence).

## PR Body Guidance

Do not summarize the patch file-by-file. Compress the human judgment:

- state the review claim
- state the safety invariant
- describe architectural effect in plain English
- call out why this slice exists
- include alternatives for non-obvious or cross-boundary choices
