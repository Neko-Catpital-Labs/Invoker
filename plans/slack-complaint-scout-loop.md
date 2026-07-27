# Goal

Find live negative product complaints written by Slack user `U0ALGQ64HMF` in
the explicitly allowlisted channels. Each actionable complaint must receive an
Approve/Cancel Invoker plan draft in its originating thread, or one exact
human-only blocker, without silently submitting a child workflow.

Motivation: messages such as Slack receiver complaints should become
evidence-backed work without requiring manual translation into a plan.

Write mode: `worker_owned_writes` for the scout ledger and approval-gated
Slack drafts only. The scout must not directly call `start_plan`, submit a
child workflow, or mutate an unrelated workflow.

# Real target

The live target set is rebuilt each pass by:

```bash
bash scripts/slack-complaint-scout-driver.sh --skip-local-check
```

The driver reads only allowlisted Slack channel history and replies, filters
to `U0ALGQ64HMF`, then deduplicates candidate complaints by:

```text
channelId|threadTs|issueFingerprint
```

The default allowlist is the configured DO1 lobby channel
`SLACK_CHANNEL_ID`. More channels must be supplied explicitly with
`--channel` or `SLACK_COMPLAINT_SCOUT_CHANNEL_IDS`; never widen the scan to
all channels or DMs.

# Success invariants

- A target is successful only when its source thread has either an
  Approve/Cancel plan draft or one precise human-only blocker.
- A Slack approval is the only path that may submit child work.
- The scout acts only on messages authored by `U0ALGQ64HMF`.
- The scout never reacts to bot messages, its own replies, or messages outside
  the allowlist.
- A plan draft must contain the complaint evidence, diagnosis, repro or
  verification command, and a bounded implementation scope.

# Fail condition

The same `channelId|threadTs|issueFingerprint` has three or more scout
attempts without a terminal approval, cancellation, or human-only blocker.
Record an `exhausted` ledger row, post one exact reason in the source thread,
and stop retrying that fingerprint.

# Evidence sources

Before writing a plan draft, consult sources in this order:

1. The full source Slack thread, including the complaint and subsequent replies.
2. Relevant DO1 Slack-manager and Invoker owner logs from the complaint window.
3. The mapped workflow and task transcripts when the channel belongs to a
   workflow.
4. The named surface's source code and focused tests.

Do not infer a root cause from sentiment alone.

# Local proxy

```bash
bash scripts/slack-complaint-scout-driver.sh --skip-live
```

The deterministic fixture must produce exactly one `slack_receiver` target and
must ignore positive, off-topic, other-user, and bot messages.

# Rebuild + rerun

- Script-only changes: rerun the local proxy command above.
- Slack surface or manager changes: run the affected package test command and
  rebuild that package before a live DO1 run.
- Before a targeted live inspection, copy the ledger to a temporary path. Do
  not use an inspection to mutate the live ledger.
- After a draft or blocker action, rerun the driver and verify the exact target
  state in the ledger and source thread.

# Loop

1. Run the local proxy and then rebuild the live target set.
2. Pick the highest-signal target that is neither terminal nor exhausted.
3. Gather the ordered evidence sources before changing code or drafting work.
4. Classify the result:
   - actionable bug or regression: create a narrow YAML plan draft and post it
     through the existing Slack Approve/Cancel draft flow;
   - human-only decision: post the exact decision needed once and mark the
     fingerprint terminal;
   - insufficient evidence: record the missing evidence and stop that
     fingerprint until new Slack activity changes it.
5. Rerun the driver. If a relevant product path is missing, add only the
   narrow bridge needed to reuse the existing plan-draft approval flow; do not
   create a new daemon or independent submit path.
6. Commit only after local proof is green for the change made.

# Exit conditions

1. **SUCCESS:** every actionable live target has an approval-gated draft and
   every human-only target has one precise blocker.
2. **STUCK:** evidence cannot establish whether the target is actionable; report
   the evidence gap without drafting generic work.
3. **OUT OF SCOPE:** the target needs a product or policy decision; surface it
   once and stop.
4. **USER STOP:** stop immediately when requested.

# Constraints

- No `~/.invoker/config.json` changes.
- No always-on owner worker or Slack-manager daemon worker.
- No automatic child workflow submission.
- No scanning DMs, arbitrary channels, or other people’s messages.
- No Slack token values in logs, plan files, commits, or reports.
- Do not use a generic negative-sentiment label as proof of a product defect.
