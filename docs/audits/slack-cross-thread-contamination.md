# Slack Cross-Thread Contamination Audit

Date reviewed: 2026-08-06

Scope: observed production Slack manager cross-thread incidents from 2026-08-05 UTC, judged against PR #7514 / commit `713eb285f` (`[Slack Channel Bleed Fix](1) Stop trusting an empty stored channelId as a session match`).

## Predicate Under Review

`SessionManager.getOrCreateSession()` and `SessionManager.getSession()` build a `SessionIdentifier(channelId, threadTs)` and then call `conversationRepo.loadConversation(id.threadTs)`. `ConversationRepository.loadConversation()` delegates to `SQLiteAdapter.loadConversation(threadTs)`, which selects the row with `WHERE thread_ts = ?`.

Before PR #7514:

- `getOrCreateSession()` recovered a persisted row when `loaded.channelId === id.channelId || loaded.channelId === ''`.
- `getSession()` accepted a persisted row unless `persisted.channelId && persisted.channelId !== id.channelId`.

After PR #7514:

- `getOrCreateSession()` recovers only when `loaded.channelId === id.channelId`.
- `getSession()` accepts only when `persisted.channelId === id.channelId`.

That fixes a real empty-`channelId` recovery hole for a row returned for the requested `threadTs`. It does not make either lookup capable of distinguishing a wrong upstream `threadTs`, and it does not explain selection of a distinct same-channel thread row because the persistence lookup is already by exact `thread_ts`.

## Incident 1: `1785890604.484199`

Observed behavior: the CodeRabbit-audit planning thread's turns 7 and 8 replied about a different thread's Slack-bot-icon scope and denied the CodeRabbit-audit thread's earlier YAML draft.

Incident verdict: unexplained

Code-path reasoning: for this incident to be explained by PR #7514's bug, the relevant lookup would have to be `SessionManager.getOrCreateSession(new SessionIdentifier(channel, '1785890604.484199'), ...)` or `SessionManager.getSession(new SessionIdentifier(channel, '1785890604.484199'), ...)` loading a persisted row whose `thread_ts` is `1785890604.484199` and whose `channelId` is blank. Before the fix, either lookup could recover that same-`threadTs` blank-channel row; after the fix, the exact-match predicate rejects it. That path does not explain why a distinct same-channel Slack-bot-icon thread's conversation would be returned for `1785890604.484199`, because the repository lookup is `loadConversation('1785890604.484199')`, not a scan by channel or any cross-thread selector.

## Incident 2: `1785890283.654509`

Observed behavior: the repo-context-default planning thread's final turns drafted silent-catch YAML belonging to other threads.

Incident verdict: unexplained

Code-path reasoning: the #7514 path could only recover persisted state for `thread_ts = '1785890283.654509'`. Before the fix, a blank `channelId` on that exact row would have been treated as a match by both `getOrCreateSession()` and `getSession()`; after the fix, blank no longer equals the requested channel and is excluded. The observed symptom names silent-catch YAML from other same-channel threads with different thread timestamps. The fixed predicate cannot make `loadConversation('1785890283.654509')` return those other thread rows, so this incident is not explained by the empty-`channelId` session match alone.

## Incident 3: `1785904741.484399`

Observed behavior: the close-empty-PRs thread's turn 2 interpreted the user's four answers as silent-catch enforcement scope.

Incident verdict: unexplained

Code-path reasoning: this is the closest match to the synthetic regression theme because the reported source content is silent-catch scope and the victim content is close-empty-PRs answers. Even so, the production facts supplied here say the involved conversations were in the same channel and persisted under stable per-thread session directories. In `thread-session-manager.ts`, the relevant lookup for the victim thread is still `conversationRepo.loadConversation('1785904741.484399')`. Before PR #7514, a blank `channelId` on that exact victim row could be recovered; after PR #7514, it is rejected. The predicate change does not provide a route for the silent-catch thread's distinct persisted row to be selected for `1785904741.484399`.

## Incident 4: `1785883369.730089`

Observed behavior: the land-stack thread's late turn answered with silent-catch docs scope.

Incident verdict: unexplained

Code-path reasoning: the only session-manager lookups that PR #7514 changed are same-requested-thread recovery lookups. For `1785883369.730089`, a pre-fix blank-channel row at `thread_ts = '1785883369.730089'` could be treated as belonging to the requested channel, and the post-fix exact predicate now excludes it. That would explain stale or wrong content already stored on the land-stack thread row, but not a lookup returning a different same-channel silent-catch docs thread row. The distinct-thread part remains outside the fixed empty-`channelId` match.

## Incident 5: `1785888856.764159`

Observed behavior: the decomposition-experiment thread's late turn folded its 5-trials answer into silent-catch docs scope.

Incident verdict: unexplained

Code-path reasoning: for this incident, `getSession()` or `getOrCreateSession()` would query `loadConversation('1785888856.764159')`. Before the fix, those methods could accept a returned row with `channelId = ''`; after the fix, they require exact channel equality and exclude that blank row. Because the observed contamination is from a different same-channel silent-catch docs thread, PR #7514 does not identify a lookup that could return the other thread's conversation for this victim thread timestamp.

## Residual Mechanism Summary

All five incidents are unexplained by PR #7514's empty-`channelId` session-match bug as stated. The fixed predicate now excludes blank-channel persisted rows for the requested thread timestamp, but the observed incidents all require either distinct same-channel thread content to have been selected, or wrong content to have already been written under the victim thread timestamp before the audited lookup ran.

A residual contamination mechanism therefore remains unless production evidence shows that each victim thread's own persisted row already contained the foreign content under its own `thread_ts`. The recommended next investigation is to correlate production logs and database snapshots for these exact thread IDs:

- `MENTION_RECEIVED`, `PASSIVE_THREAD_CONTEXT`, `getSession`, `getOrCreateSession`, `loadConversation`, and `RESPONSE_PROVENANCE` log lines, verifying the `event_ts`, `thread_ts`, `channel`, and `source_event_ts` used for each affected turn.
- `conversations` and message rows for the five victim thread timestamps and the suspected Slack-bot-icon / silent-catch source timestamps, checking whether foreign messages were already stored under victim `thread_ts` values.
- persisted planning launch context and harness session IDs keyed by each `threadTs`, checking for a reused or overwritten `harnessSessionId` that could attach one Slack thread to another model/agent conversation despite stable per-thread working directories.

If those checks show correct Slack `thread_ts` routing and clean victim conversation rows before the contaminated turns, the next likely area is the harness/session-resume layer rather than `SessionManager`'s channel predicate.
