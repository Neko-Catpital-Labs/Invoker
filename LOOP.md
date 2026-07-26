Loop instructions for the mergify_admin_requeue battle-test.
Location: /Users/edbertchan/.cursor/worktrees/pr-repair-lifecycle/intrinsic-pr-repair
Branch: pr/babysit-prereq-split (already 7 commits ahead of upstream/master --
this is ongoing real work, not a blank slate; read `git log upstream/master..HEAD`
before assuming something is unfixed).

Goal: fix real bugs in the mergify_admin_requeue worker (scripts/mergify_admin_requeue*.py
+ its TS entrypoint in packages/execution-engine/src/workers/pr-maintenance-workers.ts)
so every worker-fixable open `admin-bypass` or `dequeued` PR lands on its own,
with no human intervention on that target PR.

Real target: every open `admin-bypass` or `dequeued` PR in Neko-Catpital-Labs/Invoker either:
  A. reaches MERGED via worker actions alone, or
  B. is proven with evidence to need a human-only decision that the worker should
     surface instead of retrying blindly.
  Ground truth: run BOTH commands and dedupe by PR number:
    gh pr list --repo Neko-Catpital-Labs/Invoker --state open \
      --label admin-bypass --json number,title,labels,mergeStateStatus,updatedAt,url
    gh pr list --repo Neko-Catpital-Labs/Invoker --state open \
      --label dequeued --json number,title,labels,mergeStateStatus,updatedAt,url
  Do not trust a stale hard-coded PR list; regenerate the target set every round.

Worker-only success invariants:
- Manual intervention on a target PR does NOT count as success. No human `gh`
  comment/label/requeue/merge/close, and no manual branch surgery on that PR's
  stack branch (split, rebase, force-push, or metadata rewrite) as the way to
  "fix" it.
- A fix counts only when the worker itself causes the state change: head SHA
  changes from a worker-created repair, a missing label is restored by the
  worker, checks rerun/go green because of worker output, the PR re-enters the
  queue because of the worker, and ultimately the PR lands.
- If the only real fix is a human decision (for example "this PR must be split"),
  the correct worker behavior is to surface that specific reason once and stop
  retrying. That belongs to OUT OF SCOPE, not SUCCESS.

Fail condition: same PR still not MERGED after the worker has made 3+ attempts
at the same (kind, key) on the same headSha. Proven already in production:
  - #5803: 3x repair-check "PR Body" on head 18216e720f..., then capped. Still
    OPEN, PR Body still FAILING.
  - #5812: 3x repair-check "PR Body" on head 69361e4eed..., then capped.
A fix must make the repair actually work end to end (head changes, check goes
green, PR lands) -- not just raise the retry cap.

Evidence requirement: every stuck PR must have a recorded reason + proof before
you touch code for it. Don't guess. Use these sources, cheapest/richest first:
  1. `scripts/repro/repro-admin-bypass-non-landing-root-cause.py` (already in
     this worktree, untracked) -- queries ~/.invoker/invoker.db's activity_log
     table for the real worker's own log lines per PR, plus live `gh pr view`
     check names. This is the primary evidence tool. Extend it (new PR cases,
     new assertions) rather than writing a parallel one.
  2. ~/.invoker/mergify-admin-requeue-state.jsonl -- the ledger. One row per
     (kind, pr, headSha, key) attempt.
  3. `gh pr view <n> --json statusCheckRollup,mergeStateStatus,state` -- live
     current state of the real PR.
  4. ~/.claude/projects/-Users-edbertchan--invoker-mergify-admin-requeue-work-<pr>/*.jsonl
     -- full transcripts of each automated repair-check session (repair_check()
     in mergify_admin_requeue_exec.py shells out to a real `claude -p` session
     per attempt). Read the last assistant text block of each file for what
     that attempt actually concluded and whether it pushed.
Root causes catalogued so far (do not re-derive, extend or fix):
  - #5803: `scripts/review-unit-rules.mjs` fails because the PR's diff mixes
    3 review-unit categories (product code / tooling scripts / proof files).
    Confirmed independently by 3 separate repair-check sessions -- no PR-body
    wording fixes this, it needs the PR split. This is a genuine human-shaped
    decision, not a bug the worker can silently repair; the worker should
    surface that reasoning to a human instead of silently re-running the same
    doomed prompt 3x and posting a generic "capped" comment.
  - #5801: repaired and rebased successfully, but the worker keeps
    prioritizing capped #5803 (same stack) over advancing #5801 -- see the
    existing repro's `root_cause` string for summarize_5801.
  - #5811: left the merge queue on a Guardrails failure, but the original PR
    head never had that required-fast check context -- worker only emits
    missing-check BLOCKs, never actually repairs or requeues it.
  - #5812: branch was stale (parent PR #5811 merged, this one never rebased);
    latest repair session claims it rebased and pushed -- VERIFY this landed
    (head changed, check went green) before treating it as fixed.

Local proxy (what this loop can verify without touching real PRs):
- `./battle-loop.sh` exits 0 (unit tests + required suite + all repros).
- Each catalogued root cause above gets a fake-gh repro under scripts/repro/
  (style of repro-mergify-rejected-pr.sh) proving the failure, then proving
  the fix. Add each to battle-loop.sh's repro list.
- Two dry rounds in a row (no new failing repro found) + every fix committed
  on this branch with the repro output pasted.
- Passing the local proxy never authorizes manual cleanup of the real PRs. It
  only means the worker logic is ready for real worker verification.
- `./loop-driver.sh --skip-battle` is the quick status pass: it prints the
  deduped live target set plus the ledger's 3+-attempt fail-condition summary
  without running the local proxy.

Rebuild + rerun (every loop iteration, not just once):
- If you touched any .ts file under packages/execution-engine or
  packages/app: run `pnpm --filter @invoker/execution-engine build` (and
  `pnpm --filter @invoker/app build` if that package's worker wiring
  changed) before re-testing. The real running Invoker instance dispatches
  from built output, not from source directly -- an unrebuilt change won't
  actually take effect against real PRs.
- Python changes need no build step (interpreted from source), but clear
  stale bytecode if in doubt: `find scripts -name '__pycache__' -exec rm -rf {} +`.
- After any rebuild, rerun the worker fresh against a real stuck PR in
  --dry-run (safe, no writes) to confirm the new build actually changed its
  output, using a COPY of the ledger so you never write to the real one. The
  helper form is `./loop-driver.sh --skip-battle --pr <n>`. The raw command is:
    cp ~/.invoker/mergify-admin-requeue-state.jsonl /tmp/ledger-copy.jsonl
    python3 scripts/mergify_admin_requeue.py --dry-run --once \
      --repo Neko-Catpital-Labs/Invoker --state-file /tmp/ledger-copy.jsonl --pr <n>

Excluded: repro-mergify-stack-dogfood.sh is opt-in/LIVE (mutates real PRs on
EdbertChan/Invoker) -- not safe to run unattended, run it manually only.

Loop:
1. Rebuild + rerun per the section above if anything changed since the last
   round. Re-check BOTH ground-truth PR commands and the ledger file for the
   Fail condition; dedupe by PR number and use that live set to pick or confirm
   the next target.
2. Run `./loop-driver.sh`. Use `--skip-battle` when you only need live target
   + ledger status, or `--pr <n>` when you also want the worker dry-run for one
   target PR.
3. Any failure (required suite or a repro): root-cause it per CLAUDE.md's
   three-phase discipline (reproduce -> root cause + test gap -> fix), using
   the Evidence requirement sources above. Fix the underlying logic, not the
   repro's assertions, unless a fixture is genuinely stale.
4. All green: pick the next uncovered catalogued root cause (or, once all
   four are covered, hunt a new edge case: label races, stale ledger state,
   malformed Mergify payloads, stack reordering, flaky checks). Write ONE
   repro. Fails -> real bug, go to step 3. Passes -> note a dry round.
5. After any fix: paste both the fixed repro's and the full unit suite's
   output, then commit on this branch with a message naming the bug and
   linking the real PR it came from (e.g. "#5803").
6. Check Exit conditions below. None apply -> go to step 1. If step 1's
   ledger/PR check ever shows the Fail condition recurring for a repair kind
   already "fixed", that's a regression -- reopen it, don't raise the cap.

Exit conditions (stop when ANY is true):
1. SUCCESS: Local proxy fully met AND a fresh ground-truth + ledger check
   shows every worker-fixable real target PR reached MERGED from worker actions
   alone. "Healthy" is not enough unless it is an intermediate worker-owned
   state observed on the way to merge during the same verification pass.
   Report battle-loop.sh output, the commit list, and the before/after ground
   truth (including the Evidence requirement's proof for each PR that unstuck).
   Do NOT declare SUCCESS if a human manually edited the target PR or its stack
   branch to get there.
2. STUCK: a failure can't be root-caused after a genuine attempt -- report
   what was tried, what evidence was gathered, and why it didn't land.
3. OUT OF SCOPE: the target PR genuinely needs a human decision or a manual
   structural rewrite (for example a PR split) that the worker must only
   surface, not perform. Record the evidence, propose the decision, and stop
   rather than guessing or doing the rewrite by hand.
4. USER STOP: the user asks to stop or for a status/dry-run instead.
Do not declare SUCCESS on the Local proxy alone, and do not count manual
real-PR cleanup as worker success. The real ground-truth + ledger check must
come back clean for worker-caused progress.

Constraints:
- Work only inside this worktree
  (/Users/edbertchan/.cursor/worktrees/pr-repair-lifecycle/intrinsic-pr-repair).
  Never touch the main Invoker checkout or other worktrees.
- No comments in product code unless an allowed CLAUDE.md exception.
- Real PRs: read-only `gh pr list`/`gh pr view` and reading
  ~/.invoker/invoker.db / the ledger file are fine; no writes to real PRs
  (labels, comments, merges, closes) from this loop.
- No manual stack surgery on a target PR as a substitute for a worker fix:
  no force-push, rebase, split, retitle, PR-body rewrite, or queue command on
  the stuck PR branch just to make the target pass.
- Don't fabricate busywork: two dry rounds in a row -> stop and report.

Keep this file available for future compactions and continue following it.
