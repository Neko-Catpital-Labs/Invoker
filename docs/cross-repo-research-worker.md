# Cross-repo research worker (research swarm → Linear)

Opt-in owner worker that mines mapped source repos and submits a three-workflow
Invoker chain: discover → research swarm → file Linear tickets.

Process on/off is SQLite `worker_desired_states` (Workers UI / `worker toggles`).
It is **not** in the always-on boot list.

## Config (`~/.invoker/config.json`)

```json
"crossRepoResearch": {
  "intervalDays": 14,
  "linearTeamId": "YOUR_LINEAR_TEAM_ID",
  "maxCandidatesPerSource": 5,
  "maps": {
    "https://github.com/Neko-Catpital-Labs/Invoker.git": [
      { "repoUrl": "https://github.com/stablyai/orca", "lookbackDays": 30 }
    ]
  }
}
```

- `lookbackDays` is per source (default 30). String sources inherit the default.
- `linearTeamId` is required when `maps` is non-empty.
- Tick interval defaults to 14 days.

## Secrets

Put Linear credentials in the same secrets file used for agent keys
(typically `docker.secretsFile` or `~/.config/invoker/secrets.env`, chmod 600):

```
LINEAR_API_KEY=lin_api_...
# or
INVOKER_LINEAR_API_KEY=lin_api_...
```

Those keys are allowlisted onto **local worktree**, **SSH**, and **docker** task
environments whenever `secretsFile` is set — independent of `use_api_key`.
Do not put the key in plan YAML, ticket bodies, or logs.

Also ensure `idea-skip` exists as a Linear label for skip verdicts.

## Tick behavior

1. For each target→source map, fetch source releases/feat commits in lookback.
2. Fingerprint-dedupe against `~/.invoker/cross-repo-research/ledger.json`.
3. Submit `scripts/submit-workflow-chain.sh` with:
   - discover (`onFinish: none`)
   - research swarm (`onFinish: none`) — per candidate slot, five parallel lens
     tasks (`research-N-fit`, `research-N-peers`, `research-N-implementations`,
     `research-N-adversarial`, `research-N-effectiveness`), then a
     `research-N-synthesis` task gated on all five that writes `research-N.json`
   - file-linear (command task calling `scripts/linear-issue-create.mjs`, then
     `scrub-handoff-artifacts`)
4. The synthesis artifact carries the plan-to-invoker fields plus
   `peerLandscape`, `adversarialAnalysis`, `alternateImplementations`, and
   `effectivenessMeasurement` (leading + lagging signals beyond the fixture
   e2e check).
5. Steal tickets are unlabeled. Skip/bad tickets get `idea-skip`.
6. Never adds `invoker-ready` — you triage, then label for
   [linear-ticket-intake](linear-ticket-intake.md).
7. After filing, `scrub-handoff-artifacts` (`scripts/scrub-handoff-artifacts.sh`)
   purges any `candidates.json` / `research-*.json` / `lens-*.json` leaked into
   the git worktree and fails the task if any remain tracked or untracked. The
   home `~/.invoker/cross-repo-research` run directory (and its `ledger.json`)
   is never touched — it stays for audit.

## Manual / test

```bash
bash scripts/test-cross-repo-research-watch.sh
INVOKER_CROSS_REPO_RESEARCH_GENERATE_ONLY=1 node scripts/cross-repo-research-watch.mjs
```
