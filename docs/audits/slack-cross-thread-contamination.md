# Slack Cross-Thread Contamination Audit

Date audited: 2026-08-05

Scope: judge whether the five observed production Slack planning incidents are explained by PR #7514, commit `713eb285f` / `9184b9428`, titled "Slack Channel Bleed Fix (1) Stop trusting an empty stored channelId as a session match".

## Relevant Code Path

`SessionManager` uses an in-memory key of `channelId:threadTs`, but its persisted recovery path calls `conversationRepo.loadConversation(id.threadTs)`. The repository and SQLite schema store `conversations.thread_ts` as the primary key, so this lookup can only load the row for the requested `threadTs`.

Before PR #7514, `getOrCreateSession()` recovered a loaded row when:

```ts
loaded.channelId === id.channelId || loaded.channelId === ''
```

and `getSession()` accepted a persisted row unless:

```ts
persisted.channelId && persisted.channelId !== id.channelId
```

That meant a persisted row with `channelId === ''` was treated as belonging to whichever channel asked for that same `threadTs`, and its full message history could be attached to the active `PlanConversation`.

After PR #7514, both paths require exact channel equality:

```ts
loaded.channelId === id.channelId
persisted.channelId === id.channelId
```

Therefore, the fixed predicate excludes already-poisoned rows whose stored `channelId` is empty. It does not, by itself, explain how one same-channel thread would request another same-channel thread's `threadTs`, or how one thread's transcript would first be written under another distinct `threadTs`.

## Incident 1: `1785890604.484199` CodeRabbit-Audit Planning Thread

Observed behavior: turns 7 and 8 replied about a different thread's Slack-bot-icon scope and denied this thread's earlier YAML draft.

Incident verdict: unexplained

Reasoning: the empty-channelId bug could only surface another conversation through `conversationRepo.loadConversation(id.threadTs)` when the row loaded for `1785890604.484199` had `channelId === ''` and already contained the foreign Slack-bot-icon transcript, or when the Slack manager called the lookup with the Slack-bot-icon thread timestamp instead of `1785890604.484199`. The provided facts say this was a same-channel cross-thread incident with a stable per-thread subprocess directory, and the code path does not load "another thread in the same channel" by channel alone. PR #7514 now excludes a blank stored channel for this thread, but the observed same-channel thread switch is not explained by that predicate without additional production evidence of a blank poisoned row or wrong `threadTs` at lookup time.

## Incident 2: `1785890283.654509` Repo-Context-Default Planning Thread

Observed behavior: final turns drafted silent-catch YAML belonging to other threads.

Incident verdict: unexplained

Reasoning: pre-fix `getOrCreateSession()` could recover the row for `1785890283.654509` if that row's stored `channelId` was empty; after PR #7514 it would create a fresh session instead because `'' !== id.channelId`. That proves the fix blocks blank-channel recovery for this thread. It does not prove the source of silent-catch YAML in a different same-channel thread, because the repository lookup is keyed by exact `threadTs`, not by channel. This incident remains unexplained unless production DB or trace logs show the `1785890283.654509` row itself was already poisoned with silent-catch history while `channelId` was empty, or the manager was invoked with a silent-catch thread timestamp.

## Incident 3: `1785904741.484399` Close-Empty-PRs Thread

Observed behavior: turn 2 interpreted the user's four answers as silent-catch enforcement scope.

Incident verdict: unexplained

Reasoning: this is closest to the regression test added with PR #7514, which uses a silent-catch transcript and a close-empty-PRs conversation. However, the test's mechanism is an orphaned persisted row with `channelId === ''` being recovered for a requester using the same `threadTs`; the control case proves a real non-empty mismatched channel is not trusted. The observed incident is same-channel and cross-thread. Given distinct same-channel Slack thread timestamps, `loadConversation('1785904741.484399')` would not return the silent-catch row unless the silent-catch content was already saved under `1785904741.484399` or the wrong thread timestamp reached `SessionManager`. PR #7514 would exclude an empty stored channel for `1785904741.484399`, but it does not explain why that close-empty-PRs turn read silent-catch scope.

## Incident 4: `1785883369.730089` Land-Stack Thread

Observed behavior: a late turn answered with silent-catch docs scope.

Incident verdict: unexplained

Reasoning: before PR #7514, either `getSession()` or `getOrCreateSession()` could rehydrate the persisted row for `1785883369.730089` if its `channelId` was empty, including whatever history was attached to that exact row. After PR #7514, a blank stored channel is a mismatch and this recovery is refused. The incident still is not tied to the fixed predicate, because the provided facts describe same-channel contamination from another thread and a stable per-thread subprocess directory; the audited lookup has no query that returns another same-channel thread's conversation by topic, user, or channel. The remaining possibilities are a pre-poisoned `1785883369.730089` row or a wrong-thread routing/write path outside the empty-channel match.

## Incident 5: `1785888856.764159` Decomposition-Experiment Thread

Observed behavior: a late turn folded its 5-trials answer into silent-catch docs scope.

Incident verdict: unexplained

Reasoning: the fixed predicate now prevents recovery of a persisted `1785888856.764159` row with `channelId === ''`, so this thread cannot inherit an orphaned blank-channel row through the #7514 read path. But the observed contamination requires content from a different same-channel thread to be present in this turn's conversation. The audited code path only loads by `1785888856.764159`; it cannot select the silent-catch thread merely because both are in the same channel. Without evidence that the row for `1785888856.764159` was blank-channel and already carried the silent-catch transcript, or that Slack routing supplied the silent-catch `threadTs`, this incident remains unexplained by PR #7514.

## Residual Mechanism Summary

Residual mechanism remains: yes.

PR #7514 closes the proven read-path bug: a persisted conversation with `channelId === ''` is no longer accepted as a match in `getOrCreateSession()` or `getSession()`. PR #7515 then reduces future creation of those rows by persisting the real `channelId` from `PlanConversation.saveState()`.

The five observed incidents are not proven explained by that mechanism. They are all described as same-channel cross-thread incidents with persisted sessions and stable per-thread subprocess directories. Since the audited persistent lookup is by exact `threadTs`, an empty-channelId match can explain these incidents only if production evidence shows that the target thread row was already poisoned while its `channelId` was empty, or that the Slack manager invoked session lookup with the foreign thread's timestamp. The current evidence does not establish either condition.

Recommended next investigation: inspect production Slack manager traces and the conversation database around the five UTC timestamps for each target `thread_ts`: stored `channel_id`, message rows, `loadConversation` trace lines, `SessionIdentifier` values, `recoverActiveConversations()` entries, and any `saveConversation()` call that wrote foreign content under the target `thread_ts`. If those rows have real channel IDs and correct target timestamps before the contaminated turn, audit the Slack event routing/write path next, especially any code that maps replies to `thread_ts`, recovers active conversations after restart, persists harness session IDs, or reuses in-memory `ConversationLike` handles across Slack events.
