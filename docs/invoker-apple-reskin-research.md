# Invoker Apple-Style Reskin Research + UX Direction (2026-04-03)

## 1) Current Design Decisions (What we have now)

Code audit sources:
- `packages/ui/src/App.tsx`
- `packages/ui/src/components/TopBar.tsx`
- `packages/ui/src/components/ContextMenu.tsx`
- `packages/ui/src/components/TaskPanel.tsx`
- `packages/ui/src/components/StatusBar.tsx`
- `packages/ui/src/components/TaskNode.tsx`
- `packages/ui/src/lib/colors.ts`

Observed product decisions:
1. **Action-heavy chrome**: top bar exposes many equally weighted controls (`Open File`, `Start`, `Stop`, `Refresh`, `Clear`, `Delete DB`, view tabs), creating a “control surface” feel.
2. **Fixed 60/40 split**: DAG and details always occupy large permanent regions, even when users may only need one mode.
3. **Status color saturation**: many bright status chips and node backgrounds compete for visual hierarchy.
4. **Context menu architecture-first**: menu order largely reflects internal capabilities (restart/replace/fix/rebase/recreate/delete/cancel), not “most likely next action.”
5. **Long context menu**: workflow and destructive actions can stack into a large list with multiple separators.
6. **Frequent destructive affordances**: `Delete Workflow` and `Delete DB` are visible at all times rather than progressively disclosed.
7. **Corporate dark theme signature**: heavy `gray-700/800/900`, strong borders, and dense rectangular controls produce an ops-dashboard aesthetic.
8. **Growing workflow action surface**: 6 workflow-scoped items (rebase, retry, recreate×2, delete, cancel) plus task-level cancel. Workflow tasks show up to 14 menu items.

## 2) Apple Philosophy Signals Relevant to Invoker

### Apple menu guidance (modern HIG snippets)
From Apple’s Menus HIG page (search-crawled excerpt):
- Put important/frequent items first.
- Group related items with separators.
- Keep menus short; use submenus/splitting when too long.
- Don’t add icons ornamentally.

Source: https://developer.apple.com/design/human-interface-guidelines/menus

### Apple contextual-menu behavior (AppKit archive)
- Right-click and Control-click should both surface context menus.
- Menus are context-sensitive and validated near-open time.

Source: https://developer.apple.com/library/archive/documentation/Cocoa/Conceptual/MenuList/Articles/DisplayContextMenu.html

### Apple design principles (Apple HIG archive mirror)
Still highly relevant to interaction architecture:
- Direct manipulation and immediate feedback.
- Discoverability + explicit actions.
- Consistency with user expectations.
- Forgiveness for risky actions.
- Aesthetic integrity: simple graphics, avoid clutter.

Source: https://leopard-adc.pepas.com/documentation/UserExperience/Conceptual/AppleHIGuidelines/XHIGHIDesign/XHIGHIDesign.html

### Evidence for “bias to likely action”
- **Hick (1952), Hyman (1953):** decision time increases with number/uncertainty of choices.
- **Fitts (1954):** interaction speed improves when targets are easier/faster to hit.

Sources:
- https://journals.sagepub.com/doi/10.1080/17470215208416600
- https://pubmed.ncbi.nlm.nih.gov/13052851/
- https://pubmed.ncbi.nlm.nih.gov/1402698/

## 3) UX Direction: “Calm Command Center”

Design goal:
- Keep Invoker powerful, but visually quiet and action-biased.
- Surface one obvious next action per state.
- Move irreversible/destructive actions into secondary disclosure.

Principles to enforce:
1. **Primary-first ordering**: first menu item should match most likely user intent for that task state.
2. **Progressive disclosure**: keep dangerous/rare actions behind one additional step.
3. **Low-noise surfaces**: fewer saturated colors; more neutral layers and subtle depth.
4. **Context-local controls**: actions close to selected task instead of global toolbar overload.
5. **Predictable interactions**: right-click and keyboard alternatives; consistent status semantics.

## 4) Proposed Interaction Model Changes

### 4.1 Global top bar
- Keep: `Open`, view switcher, run state (`Start`/`Stop`).
- Move `Refresh`, `Clear`, `Delete DB` under a single `•••` utility menu.
- Emphasize current workflow title + state over utility buttons.

### 4.2 Context menu (state-adaptive)
Make it intent-driven per status:
- `failed`: `Fix with <preferred agent>` first.
- `running`: `Open Terminal` first.
- `pending`: `Restart Task` first.
- `completed/stale`: `Open Terminal` then `Restart Task`.

Put workflow-wide actions in a grouped footer section:
- **Workflow (safe)**: Rebase & Retry, Retry Workflow (keep completed)
- **Workflow (destructive, behind labeled separator)**: Recreate from Task, Recreate Workflow, Cancel Workflow, Delete Workflow

Move destructive actions into `More…` submenu.

### 4.3 Dropdowns/selects in TaskPanel
- Turn executor/agent selectors into compact segmented or pop-up controls with short labels.
- Avoid showing multiple advanced selectors unless the task is selected and editable.
- Keep labels plain language (`Run on`, `Agent`, `Merge mode`).

## 5) Mockup Diagrams

## 5.1 Main layout (desktop)

```text
┌──────────────────────────────────────────────────────────────────────────────┐
│ Invoker            Plan: release-train.yml        [DAG|Timeline|Queue] [▶] │
│                                                     [•••]                    │
├──────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  DAG Surface (fluid, dominant)                     Inspector (contextual)    │
│  ┌───────────────────────────────┐                 ┌──────────────────────┐  │
│  │                               │                 │ task-alpha           │  │
│  │           nodes+edges         │                 │ Failed               │  │
│  │                               │                 │                      │  │
│  │                               │                 │ Primary: Fix         │  │
│  └───────────────────────────────┘                 │ Secondary controls   │  │
│                                                    └──────────────────────┘  │
├──────────────────────────────────────────────────────────────────────────────┤
│ Total 42    Running 3    Failed 1    Pending 8    (chips, subtle, clickable)│
└──────────────────────────────────────────────────────────────────────────────┘
```

## 5.2 Right-click context menu (failed task)

```text
┌──────────────────────────────────┐
│ Fix with Claude        Primary   │
│ Fix with Codex                  │
│ Restart Task                    │
│ Replace with…                   │
│──────────────────────────────────│
│ Open Terminal                   │
│──────────────────────────────────│
│ ── Workflow ──                  │
│ Rebase & Retry                  │
│ Retry Workflow                  │
│──────────────────────────────────│
│ ── Danger ──                    │
│ Cancel Task (+ dependents)      │
│ Recreate from Task              │
│ Recreate Workflow               │
│ Cancel Workflow                 │
│ Delete Workflow                 │
└──────────────────────────────────┘
```

## 5.3 Context menu (running task)

```text
┌──────────────────────────┐
│ Open Terminal   Primary  │
│──────────────────────────│
│ Cancel Task (+ deps)     │
│ More… ▸                  │
└──────────────────────────┘
```

## 5.4 Utility menu (top-right)

```text
•••
  Refresh
  Clear Session
  ─────────────
  Danger Zone ▸
    Delete Workflow History (DB)
```

## 6) Visual Language Direction (Apple-adjacent, not mimicry)

- Neutral base: warm dark grays, reduced border contrast, soft translucency where useful.
- Typography: SF-compatible stack with tighter hierarchy, fewer all-caps labels.
- Shape: slightly larger radii, less “boxed” button styling.
- Motion: subtle 120-180ms state transitions; no decorative animation loops.
- Depth: one elevation system for menu/popover/modals, not many competing shadows.

## 7) Implementation Plan (Low-risk)

Phase 1 (behavior before paint):
1. Extract context menu logic into pure function by task status.
2. Reorder items by likely action and collapse destructive options into `More…`.
3. Add ARIA + keyboard nav + viewport clamping.

Phase 2 (global simplification):
1. Top bar reduction: move low-frequency actions into utility menu.
2. Status bar visual simplification and consistent chip behavior.
3. Task panel progressive disclosure for advanced controls.

Phase 3 (visual polish):
1. Tokenized color + spacing + radius + elevation system.
2. Palette and border/hover normalization.
3. Snapshot updates + visual-proof captures.

## 8) Risks / Tradeoffs

1. Power users may initially miss always-visible destructive controls.
2. Strong simplification can hide advanced options if disclosure is too deep.
3. Apple-like visual language without native components can feel “off” if motion/spacing aren’t tuned together.

Mitigation:
- Keep command discoverability via searchable command palette and menu bar parity.
- Add lightweight onboarding hints on first right-click.
- Run snapshot and e2e tests for every menu-state permutation.

## 9) Immediate Recommendation

Start with context menu IA + utility-menu consolidation first. This gives the highest “less corporate, more purposeful” impact with minimal architecture churn and validates the likely-action strategy quickly.

## 10) Updated Visual Mockups (What it would look like)

### 10.1 App shell (default, no task selected)

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Invoker   Plan: release-train.yml                    DAG  Timeline  Queue     [▶]  │
│                                                       Healthy • Running 3      [•••]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  Graph Workspace (full-width emphasis)                                               │
│  ┌────────────────────────────────────────────────────────────────────────────────┐   │
│  │                                                                                │   │
│  │   task-a ─────▶ task-b ─────▶ merge                                            │   │
│  │      ╲            │                                                            │   │
│  │       ╲           ▼                                                            │   │
│  │        └──────▶ task-c                                                         │   │
│  │                                                                                │   │
│  └────────────────────────────────────────────────────────────────────────────────┘   │
│                                                                                      │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Total 42   Running 3   Failed 1   Pending 8   Needs Input 1   (subtle filter chips)│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 10.2 App shell (task selected; inspector slides in)

```text
┌──────────────────────────────────────────────────────────────────────────────────────┐
│ Invoker   Plan: release-train.yml                    DAG  Timeline  Queue     [▶]  │
│                                                       Healthy • Running 3      [•••]│
├──────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                      │
│  Graph Workspace (70%)                              Inspector (30%)                  │
│  ┌──────────────────────────────────────────────┐   ┌──────────────────────────────┐ │
│  │ selected: task-b (failed)                    │   │ task-b                        │ │
│  │                                              │   │ Failed • 3m ago               │ │
│  │                                              │   │                               │ │
│  │                                              │   │ [ Fix with Claude ]           │ │
│  │                                              │   │ [ Open Terminal ]             │ │
│  │                                              │   │                               │ │
│  │                                              │   │ Details                        │ │
│  │                                              │   │ - Agent: Claude              │ │
│  │                                              │   │ - Run on: Worktree           │ │
│  │                                              │   │ - Merge mode: GitHub         │ │
│  └──────────────────────────────────────────────┘   │                               │ │
│                                                     │ More ▸                        │ │
│                                                     └──────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────────────┤
│  Total 42   Running 3   Failed 1   Pending 8   Needs Input 1   (subtle filter chips)│
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### 10.3 Right-click menu (failed task, scalable agent model)

```text
┌────────────────────────────────────────┐
│ Fix with Claude              Primary   │
│ Fix with… ▸                           │
│ Restart Task                          │
│ Replace with…                         │
│────────────────────────────────────────│
│ Open Terminal                         │
│────────────────────────────────────────│
│ ── Workflow ──                        │
│ Rebase & Retry                        │
│ Retry Workflow                        │
│────────────────────────────────────────│
│ ── Danger ──                          │
│ Cancel Task (+ dependents)            │
│ Recreate from Task                    │
│ Recreate Workflow                     │
│ Cancel Workflow                       │
│ Delete Workflow                       │
└────────────────────────────────────────┘

Fix with… ▸
  - Codex
  - Cursor
  - Gemini
  - Other installed agents…

More… (Phase 1 uses labeled separators instead)
  - Recreate from Task
  - Recreate Workflow
  - Cancel Workflow
  - Delete Workflow
```

### 10.4 Top-right utility dropdown (de-corporatized chrome)

```text
[•••]
  Refresh
  Clear Session
  ─────────────
  Export Logs…
  Settings…
  ─────────────
  Danger Zone ▸
    Delete Workflow History (DB)
```

### 10.5 Motion storyboard (smooth but restrained)

```text
A) Select task node
   node ring: 0% -> 100% in 140ms ease-out
   inspector: x +12px/opacity 0 -> x 0/opacity 1 in 180ms ease-out

B) Open context menu
   menu: scale 0.98 -> 1.00 + opacity 0 -> 1 in 120ms ease-out

C) Switch DAG -> Timeline
   content crossfade: 120ms
   selected task highlight retained across views

D) Apply status filter
   non-matching nodes: opacity 1 -> 0.20 in 90ms
   matching nodes: unchanged (no bounce/pulse)
```

### 10.6 Merge/PR review flow (remove "approve twice" feeling)

#### A) Inspector action labels (before opening modal)

```text
Merge-mode workflow gate in awaiting_approval:
  [ Review Merge… ]   [ Reject ]

PR-mode workflow gate in awaiting_approval:
  [ Review Pull Request… ]   [ Reject ]

AI-fix approval:
  [ Review Fix… ]   [ Reject ]
```

#### B) Merge review modal (manual merge mode)

```text
┌────────────────────────────────────────────────────────────────────┐
│ Review Merge                                                      │
│ task: __merge__wf-1                                               │
│                                                                    │
│ Summary                                                            │
│ - 12 tasks completed                                               │
│ - 1 fix applied                                                    │
│ - Target branch: main                                              │
│                                                                    │
│ Diff + notes (scroll)                                              │
│ ┌──────────────────────────────────────────────────────────────┐    │
│ │ ...                                                         │    │
│ └──────────────────────────────────────────────────────────────┘    │
│                                                                    │
│ [Cancel]   [Reject Merge]                         [Merge Now]      │
└────────────────────────────────────────────────────────────────────┘
```

#### C) Pull request review modal (PR mode)

```text
┌────────────────────────────────────────────────────────────────────┐
│ Review Pull Request                                                │
│ task: __merge__wf-1                                                │
│                                                                    │
│ PR Details                                                         │
│ - Base: main                                                       │
│ - Feature: invoker/wf-1                                            │
│ - Draft title/description preview                                  │
│                                                                    │
│ Validation notes (scroll)                                          │
│ ┌──────────────────────────────────────────────────────────────┐    │
│ │ ...                                                         │    │
│ └──────────────────────────────────────────────────────────────┘    │
│                                                                    │
│ [Cancel]   [Reject PR]                        [Create Pull Request] │
└────────────────────────────────────────────────────────────────────┘
```

#### D) Copy/label contract (proposed)

```text
TaskPanel button labels:
  - "Approve Merge"          -> "Review Merge…"
  - "Approve" (PR flows)     -> "Review Pull Request…"
  - "Approve Fix"            -> "Review Fix…"

Modal titles:
  - "Confirm Merge"          -> "Review Merge"
  - "Confirm Pull Request"   -> "Review Pull Request"
  - "Approve AI Fix"         -> "Review Fix"

Modal primary CTA:
  - Merge flow               -> "Merge Now"
  - PR flow                  -> "Create Pull Request"
  - Fix flow                 -> "Approve Fix"
```

#### E) Interaction sequence (new)

```text
1. User clicks "Review Merge…"
2. Modal opens with merge summary + context
3. User chooses:
   - Merge Now (primary)
   - Reject Merge
   - Cancel
```
