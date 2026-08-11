# ELI5 trigger corpus

Real examples mined from `~/.claude/projects/**/*.jsonl`,
`~/.codex/sessions/**/*.jsonl`, and `~/.codex/history.jsonl` (case-insensitive
search for "eli5" / "eli 5" / "explain like i", deduped to genuine human-typed
messages). Used to calibrate when `diu` should trigger.

## Examples (most-recent-first, deduped)

1. "eli5 the workflow orchestration architecture"
2. "ok thats a problem: it should be stacked. Why wouldn't it be stacked? eli5 < 40 words"
3. "ELI5 THE SOLUTION" (after a frustrated all-caps venting streak)
4. "Eli5 , I do not understand" (after multi-turn technical back-and-forth on IPC race conditions)
5. "explain what we are doing here and why? eli5. PR summary is too wordy and confusing"
6. "eli5 < 40 words" (after a Kotlin Flow/Dispatchers.IO diff explanation)
7. "Theres so much here wtf... I can't understand it... keep it ELI5. Assume i am a burnt out engineer... who can only understand language of a 5 year old"
8. "ELI5 < 40 words. I don't understand" (after an ambiguous status report)
9. "why is it stuck? prove root cause with rerpo script and ELI5. And why is this loop allowed to happen"
10. "yes please check. ELI5 and let me know if we run these manual tests on e2e on its own?"
11. "eli5 <bare PR link>" (no other words)
12. "can you tell me if PR 8056 and PR 8058 are duplicates? Also eli5 for each of these"
13. "eli5 < 40 words" (standalone, bare follow-up)
14. "ok but why were those files removed to begin with? eli5 < 40 words"
15. "eli5 < 40 words, how do i fix this"
16. "eli5: what is the issue? that we werent targeting master?"
17. "what was the bug? eli5. and is this balance on the server as well? how does the transaction actually work?"
18. "ELI5: Is this a deliberate design? ... Is this a UI bug or a bug in the database?"
19. "ELI5. If hte worker is working to fix PRs with admin-bypass, why is 6245 not under repair? ELI 5 < 40 words" (uses both "ELI5" and spaced "ELI 5" in one message)
20. "ELI5 what do you need me to do to get the video"
21. "eli5. 1. Why was there a stale approve AI fix that got applied? ... 2. Who fired that?"
22. "Eli5. I'm confused why do1 and do2 are a blocker to ci"

## Patterns

- **Proactive, not reactive.** "eli5" almost always appears in the same message
  as the question, not as a follow-up complaint after a bad answer.
- **Explicit word caps are common.** "< 40 words" or "< 50 words" is frequently
  appended to "eli5" as part of the same instruction.
- **Bare triggers happen.** Several messages are just "eli5" or "eli5 <link>"
  with no other words — the trigger must work with zero surrounding context.
- **Topic skew.** The large majority are root-cause/"why" debugging questions,
  architecture explanations, or PR summaries — not general knowledge questions.
- **Spelling is inconsistent.** eli5 / ELI5 / Eli5 / "ELI 5" (spaced) all occur,
  sometimes both forms in one message — matching must be case-insensitive and
  tolerate an optional space before the digit.
