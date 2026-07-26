# Goal
Continue the babysit worker loop on top of `pr/babysit-prereq-split` so worker-owned `admin-bypass` / `dequeued` PR failures either land through worker actions or get surfaced as explicit human-only blockers.

# Verified facts
- `edbde014b` is pushed to `origin/pr/babysit-prereq-split`.
- `bash ./loop-driver.sh --skip-battle --pr 5803` now shows `DRY-RUN repair-check PR #5803 check="PR Body"` instead of the old capped block.
- A real rerun on `#5803` recorded `repair-invalid` with the exact human-split reason and posted that reason back to the PR.
- `bash ./loop-driver.sh` is green locally after the worker and repro changes.

# Scope
- Stay on the worker path only. No manual PR edits, queue comments, rebases, splits, force-pushes, or label changes on target PRs.
- Follow `LOOP.md` exactly.
- Regenerate the live target set every round with `loop-driver.sh` / the two `gh pr list` commands in `LOOP.md`.
- When a worker rerun exposes a real blocker, fix worker logic and rerun the worker.

# Proposed workflow
1. Run `bash ./loop-driver.sh --skip-battle` to refresh the live target set and ledger fail summary.
2. Pick the highest-signal worker-owned target from that live set.
3. Gather proof from the ledger, `gh pr view`, existing repros, and repair transcripts.
4. If the blocker is worker-fixable, change the worker, add or extend a repro, rerun `bash ./loop-driver.sh`, then rerun the real worker on the target PR.
5. If the blocker is human-only, make the worker surface the exact reason once and stop retrying.
