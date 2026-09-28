# Side-checkout repair sessions — DO1 forensic (2026-09-27 UTC)

## Dominant mechanism

**Repair agents leave the Invoker task checkout by creating a second git worktree when `git checkout <pr-branch>` fails** (branch already checked out elsewhere, or the task worktree directory was deleted mid-run). They then commit in `/home/invoker/pr…-repair…` or `/tmp/pr…-repair` and report “did not push.” `pr_worker_safe_push` only sees the original task checkout, so the PR head never moves.

A second, related Vitest pattern: fix-ci sessions intentionally add detached repro worktrees under `/tmp/invoker-…` and edit there without committing back into the task checkout.

## Window totals (agent-sessions mtime on 2026-09-27 UTC)

| Bucket | Count |
| --- | --- |
| All matched sessions | 110 |
| `side-edit-or-no-commit` | 60 (mostly Vitest / scratch cwd noise) |
| `other` | 20 |
| `side-worktree-then-commit` | 14 |
| `committed-in-cwd-claimed-no-push` | 9 |
| `no-git-ops-parsed` | 7 |

Non-Vitest repairs that day: `other` 20, `committed-in-cwd-claimed-no-push` 9, `no-git-ops-parsed` 7, **`side-worktree-then-commit` 6**.

## Catstack #1198 (head `bc9ad0c319`, three attempts)

### `01a0e0f4-53b6-…` — side-worktree-then-commit

- **Task cwd:** `…/experiment-wf-1790480470895-153-repair-…`
- **Agent intent:** “The branch is already checked out in another local worktree, so this checkout can’t attach the same branch name… I’m switching to that existing branch worktree…”
- **Command:** `git -C …/repos/e797aee25f4d worktree add /home/invoker/pr1198-repair-20260927 FETCH_HEAD`
- **Final:** Fixed locally; commit `7c22092` in `/home/invoker/pr1198-repair-20260927`; did not push.

### `01a0e150-51b4-…` — side-worktree-then-commit

- **Task cwd:** `…/experiment-wf-1790486500623-179-repair-…`
- **Agent intent:** worktree directory removed during interrupted install-test; recreate checkout elsewhere.
- **Command:** `git worktree add /tmp/pr1198-repair pr/skills-registry`
- **Final:** commit `a3e3f19f` in `/tmp/pr1198-repair`; did not push.

### `01a0e1ac-a513-…` — committed-in-cwd-claimed-no-push

- Switched onto `pr/skills-registry` inside the task worktree and committed there; still ended with “did not push” (prompt-mandated). That attempt is the intended local-commit path for safe-push, not a side-checkout.

## Vitest Workspace (fix-ci)

Agents follow a “detached repro worktree” habit, e.g.:

- `git worktree add --detach /tmp/invoker-repro-c3942a5-vitest c3942a5b…`
- Final messages: “Implemented the narrow fix in … `/tmp/invoker-fix-ci-…`” with **no commit in the task cwd**.

So the Vitest repeats are the same publication miss (edits not on the branch safe-push reads), driven by repro-worktree practice rather than a locked PR branch.

## Prompt link

[`scripts/mergify_admin_requeue_async_repair.py`](../scripts/mergify_admin_requeue_async_repair.py) tells the agent:

```text
Work directly on its branch:
  git fetch origin <head> && git checkout <head>
```

That `git checkout` is what fails when another worktree already holds the branch, which is the first step in the #1198 side-worktree chain.

## Non-goals of this report

Does not change the 3-attempt cap. Does not enable the weekly efficiency rollup. Exit-21 unpublished settle is tracked separately (PR #13671).

## Raw data

Collector output on DO1: `/tmp/side-checkout-forensic.json` (full) and `/tmp/side-checkout-forensic-focused.json` (Sep 27 subset). Re-run: push `/tmp/do1-side-checkout-forensic.py` via `scripts/fleet-ssh.sh --hosts remote_digital_ocean_1 --push-and-run`.
