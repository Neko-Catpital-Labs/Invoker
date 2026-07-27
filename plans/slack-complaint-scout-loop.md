# Slack Complaint Scout Loop

Goal: run one bounded, task-driven Slack complaint scout pass on DigitalOcean 1.

Safety invariant:
- Read only explicit allowlisted Slack channels.
- Treat only author `U0ALGQ64HMF` messages as complaint evidence.
- Write only `~/.invoker/slack-complaint-scout-ledger.jsonl`, a Slack Approve/Cancel plan draft, or one exact terminal blocker in the source thread.
- Never scan DMs, all channels, or other authors as discovery targets.
- Never call `start_plan` or submit a child workflow from the scout. The existing Slack plan draft Approve action remains the only submission path.

Stable target key: `channelId|threadTs|issueFingerprint`.

Attempt policy:
- Skip targets already marked `drafted` or `terminal`.
- Stop after three failed attempts for the same stable target key and post one terminal blocker.
- A terminal blocker must state the exact human-only reason.

Implementation shape:
- `scripts/slack-complaint-scout-driver.sh` owns the bounded local/live pass.
- `scripts/slack-complaint-scout-discover.py` owns allowlisted discovery, evidence inspection, candidate decisions, and ledger writes.
- `packages/surfaces/src/slack/slack-surface.ts` owns the Slack plan draft rendering and Approve/Cancel actions.
- `packages/slack-manager/src/index.ts --stage-plan-draft payload.json` is a one-shot bridge that posts an existing plan draft and exits without starting Socket Mode.

Acceptance checks:
- `python3 scripts/slack-complaint-scout-discover.py --self-test`
- `pnpm --filter @invoker/surfaces test -- slack-plan-draft-approve.test.ts`
- `pnpm --filter @invoker/slack-manager test -- complaint-scout-bridge.test.ts`
- `pnpm --filter @invoker/surfaces build`
- `pnpm --filter @invoker/slack-manager build`
- `scripts/slack-complaint-scout-driver.sh --skip-live`
