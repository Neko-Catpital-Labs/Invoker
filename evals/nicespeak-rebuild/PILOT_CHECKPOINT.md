# Pilot checkpoint — human review required

Status: **paused after instrumentation + pilot plan generation**

## Completed before this checkpoint
1. Invoker telemetry: Kimi/Qwen session drivers, versioned equivalent-API pricing, cache-hit rollups, same-agent autofix inheritance, eval budgets.
2. Eval controller under `evals/nicespeak-rebuild/` with frozen specs, renderer, isolation preflight, transcript audit.
3. Target repo seeded: `nicespeak_invoker` `main` @ `fd5c8a6a20f4cbd265092e37429e4450e1d02437`.
4. 40 pilot workflows rendered; first workflow per lineage passes `skill-doctor`.
5. Reporting pipeline ready (`reporting/report.mjs`); empty-ref report is deterministic.

## Do not expand yet
Do not authorize the remaining ~20 live features until the 10-feature × 4-model pilot has been reviewed for:
- cost / cache / autofix attribution quality
- cheap-vs-premium git-diff similarity usefulness
- isolation integrity (no NiceSpeak source leakage)

## Submit the pilot when ready
```bash
# Ensure local Invoker owner is up with evals/nicespeak-rebuild/fixtures/invoker-eval-config.snippet.json merged
# and autoFixAgent unset (so repairs inherit task agent/model).

SUBMIT=1 bash evals/nicespeak-rebuild/scripts/run-pilot.sh

# After lineages finish:
node evals/nicespeak-rebuild/reporting/report.mjs /path/to/nicespeak_invoker \
  evals/nicespeak-rebuild/generated/reports \
  /path/to/cost-events.json
```

## Safety reminder
Rotate any API keys that were pasted into chat. Configure Kimi/Qwen credentials only via local CLI login / env, never in git or reports.
