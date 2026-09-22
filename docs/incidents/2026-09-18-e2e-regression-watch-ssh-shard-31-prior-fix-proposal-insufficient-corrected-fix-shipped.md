# `e2e-regression-watch` `ssh / shard-31` needs-human: the fix proposed by 3 prior investigations would not have worked -- corrected fix implemented this session

**Date:** 2026-09-18, ~09:08 UTC
**Context:** Investigating a production `e2e-regression-watch` finding: `scripts/e2e-regression-watch.mjs` exhausted its automated fix-attempt retry budget and marked a failure `needsHuman` -- `repair_filings` id 14710, kind `ci-regression-needs-human:ssh-shard-31:job`, subject `master`, first-bad stateSha `f4c2f0164b6cb258726ca705b965605121963077`, `created_at='2026-09-18 08:39:32'`, `metadata: {"jobName":"ssh / shard-31","failureId":"job","attempt":4}`.

## This finding's root cause was already correctly diagnosed twice

`docs/incidents/2026-09-17-e2e-regression-watch-ssh-shard-31-needs-human-oauth-not-alerted.md`, `docs/incidents/2026-09-18-e2e-regression-watch-ssh-shard-31-needs-human-oauth-still-unresolved.md`, and `docs/incidents/2026-09-18-e2e-regression-watch-ssh-shard-31-needs-human-oauth-still-unfixed.md` all independently reached the same, correct immediate diagnosis: all 3 automated fix attempts for `ssh / shard-31` (`wf-1789645833608-157`, `wf-1789650367764-175`, `wf-1789658282041-13`, all `/fix-ci-f4c2f01-ssh-shard-31`) died on turn one with `Failed to authenticate: OAuth session expired and could not be refreshed`, never touching the real CI failure, and `infra-repair-worker.ts`'s `handleOauthSessionExpiredRecovery` -- which exists specifically to record an operator alert instead of silently burning attempts -- never saw any of them, because its scan (`listInfraRepairScanCandidates:354`) and validator (`validateGenericSshInfraCandidate:394`) both hard-require `task.config.runnerKind === 'ssh'`, and all 3 attempts ran with `runnerKind: 'worktree'`.

Re-verified fresh this session, live `invoker.db`, read-only:
```sql
SELECT count(*), min(created_at), max(created_at) FROM tasks WHERE failure_class='ssh-oauth-session-expired'
  -> 136 rows, min=2026-09-16T23:56:21.652Z, max=2026-09-18T03:30:59.962Z
SELECT runner_kind, count(*) FROM tasks WHERE failure_class='ssh-oauth-session-expired' GROUP BY runner_kind
  -> scratch: 10, worktree: 126   (zero with runner_kind='ssh')
```
Still true, still unfixed as of this session's start.

## The specific fix all 3 prior docs proposed would not have worked

All 3 docs propose the same fix: "widen `infra-repair-worker.ts`'s candidate filter (`:354` and `:394`) to also accept `runnerKind === 'worktree'`/`'scratch'`". This session traced one layer further than any of the three did, and that fix is insufficient on its own:

`validateGenericSshInfraCandidate` (`infra-repair-worker.ts:385-408`), even with the `runnerKind` check widened, still calls `resolveRemoteTargetId` → `resolveSelectedRemoteTargetId` (`conflict-resolver.ts:330`), which resolves an SSH pool member from `task.config.poolMemberId` or a `task.executor.selected` event's `poolMemberId` payload. If that returns `undefined`, the candidate is dropped at `if (!targetId) return undefined;` (`:403`) -- before `handleOauthSessionExpiredRecovery` is ever reached. This is not hypothetical; it's the observed state of every real occurrence:

```sql
SELECT count(*), sum(CASE WHEN pool_member_id IS NOT NULL THEN 1 ELSE 0 END)
  FROM tasks WHERE failure_class='ssh-oauth-session-expired' AND runner_kind IN ('worktree','scratch')
  -> (136, 0)
```

**Zero of the 136 non-ssh OAuth-failed tasks have a `pool_member_id`.** All run with `pool_id='local-only'` -- confirmed directly against the 3 named `fix-ci-f4c2f01-ssh-shard-31` tasks:
```text
wf-1789645833608-157/fix-ci-f4c2f01-ssh-shard-31  runner_kind=worktree  pool_id=local-only  pool_member_id=NULL
wf-1789650367764-175/fix-ci-f4c2f01-ssh-shard-31  runner_kind=worktree  pool_id=local-only  pool_member_id=NULL
wf-1789658282041-13/fix-ci-f4c2f01-ssh-shard-31   runner_kind=worktree  pool_id=local-only  pool_member_id=NULL
```

The reason is architectural, not accidental: `handleOauthSessionExpiredRecovery`'s alert (`:1104-1150`) is keyed on `candidate.targetId`, a specific SSH remote pool member -- it's designed to quarantine or flag *that host's* credential, for the case where CI-regression fix tasks execute via SSH remote. But these tasks execute locally (`worktree` runner, `local-only` pool). The error text ("Failed to authenticate: OAuth session expired and could not be refreshed") is generic and is emitted identically by the local agent-CLI invocation, which `FailureClassifier.classifyError` (`failure-classifier.ts:83-85`) matches into the same `ssh-oauth-session-expired` class regardless of which credential actually expired -- a real class-name/scope collision between "an SSH pool member's session expired" and "the local agent-CLI's session expired", two different failures needing two different remediations, sharing one classifier bucket and one (SSH-only) repair pathway.

Widening the two `runnerKind` checks alone would have changed nothing observable: every occurrence would still fall through `if (!targetId) return undefined` immediately afterward, silently, exactly as today. This is why the fix has been proposed three times without shipping and would have shipped a no-op even if it had.

## Corrected fix (implemented this session, not just proposed)

Added a second, independent candidate path that never resolves an SSH remote target, because non-ssh tasks don't have one:

- `listLocalOauthInfraRepairScanCandidates` -- scans for `status === 'failed' && runnerKind !== 'ssh' && failureClass === 'ssh-oauth-session-expired'`.
- `validateLocalOauthInfraCandidate` -- same staleness/liveness checks as the SSH path, no `resolveRemoteTargetId` call.
- `handleLocalOauthSessionExpiredRecovery` -- records the same shape of operator alert (`repair-target` / `repair-infra-failure` worker-action rows, same cooldown mechanism via `getWorkerAction`/`repairCooldownMs`) but keyed on a fixed `local-agent-cli` target key instead of a resolved SSH `targetId`, since every non-ssh task on this machine shares one local agent-CLI credential.
- Wired into `createInfraRepairTick`: both scan lists feed the same dedupe/validate loop; `validateGenericSshInfraCandidate` is tried first (preserves existing SSH-pool-member behavior unchanged), and only candidates it rejects fall through to `validateLocalOauthInfraCandidate`.

`packages/execution-engine/src/workers/infra-repair-worker.ts` (+118 lines), `packages/execution-engine/src/__tests__/infra-repair-worker.test.ts` (+107 lines, 3 new tests: scan-includes-local-oauth, records-alert-without-pool-member, cooldown-dedup). Full suite for this file: **27/27 passed** (24 pre-existing unchanged + 3 new), `pnpm exec vitest run src/__tests__/infra-repair-worker.test.ts` in `packages/execution-engine`, run this session.

## Still open (unchanged from prior docs, out of this fix's scope)

1. **Operational:** the local agent-CLI credential itself still needs an operator to re-authenticate it. This fix makes that failure *visible* (one alert, not silence); it does not refresh the credential.
2. **`e2e-regression-watch.mjs` still charges its 3-attempt budget for infra-class failures**, `shouldFileFailure`/`shouldRetry` (`:580-631`) don't distinguish a real fix attempt from one that died on auth before touching the CI failure. Decoupling that (checking the filed task's resulting `failure_class` in `processFailureFilingSweep`, `:1449-1579`, before calling `recordFailureFiled`) is still correct and still unshipped -- this session scoped to the alert-visibility gap because that's what made 3 independent diagnoses land on a no-op fix; the budget-decoupling fix doesn't have that same correctness problem, just unshipped-proposal status.
3. **`claude-oauth-refresh` worker still logs no per-tick outcome** -- still can't tell whether its scheduled refresh runs, succeeds, or fails.

## What was changed in this pass

Implemented in an isolated worktree (`git worktree add` off `origin/master` at `058ae7eec`, branch `fix/infra-repair-local-oauth-alert`) -- not the shared live checkout, which has 309 untracked files from concurrent sessions. Code change + tests only; no `repair_filings` row touched, no credential refreshed, no production worker restarted. PR opened against `master`, not merged.
