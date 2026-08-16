---
name: reflect
description: Mine a conversation transcript — and the commit history of the files it touched — for durable learnings, then route the real ones into concrete skill edits through explicit user approval. Use when the user says reflect, after a complex multi-step task lands cleanly and the recipe is worth keeping, when the agent hit dead ends before finding a working path, or when the user corrected the agent's approach mid-task.
disable-model-invocation: true
---

# Reflect

Mine a transcript for durable learnings, then turn the real ones into skill edits — never silently.

Adapted from `pstack`'s `reflect` (cursor/plugins), rewritten for Claude Code: transcripts live under `~/.claude/projects/`, review fan-out uses the `Agent` tool, and there's no `create-skill` built-in to hand substantive edits to — the parent writes them directly.

Not every finding belongs in a skill edit here. A finding about the *user's working style or preferences* (not a code lesson) routes to the sibling skill `automate-me` instead — see step 4.

## Always run inside a subagent

Every invocation of this skill — single-transcript or multi-conversation mode — runs inside a subagent, no exceptions. The parent assistant launches it via the `Agent` tool (`subagent_type: general-purpose` is the default fit: the process reads transcripts fresh from disk and doesn't need the parent's own conversation context) with the user's original reflect arguments/scope, then waits for it to report back. The subagent runs steps 1-4 (locate transcript(s), cost audit, lens fan-out, synthesis) — that's the large part: multi-transcript reads, cost-audit output, several parallel lens-reviewer `Agent` calls, a synthesis `Agent` call. The parent runs steps 5 and 6 itself, in the main thread, never delegated: presenting the Accepted / Backlog / Route-to-automate-me / Rejected list and getting the user's approval, then applying the approved subset. This keeps the bulk of the investigation out of the parent's context window — the parent only needs the final synthesized findings list.

## When to invoke

- The user said "reflect."
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.
- A session, or a corpus-scan bucket, shows heavy user involvement — many corrections, clarifying answers typed out by hand, repeated manual confirmations — over a short span. That's a signal a durable preference exists and hasn't been captured yet, not just a signal something went wrong; hand it to `automate-me` (step 4) rather than writing a one-off skill edit for it.
- It's been a while since the corpus-wide pass (`top_sessions.py` + this skill's lenses across the worst offenders) last ran. No fixed cadence and no cron — just periodically worth doing by hand, since a single pass has reliably turned up real, evidence-backed findings each time so far.
- The user asks *why does X keep happening* across a span of time or across machines — e.g. "why do these PRs keep thrashing," "look at all our conversations from the last day," "check every DO worker." That's a request for **multi-conversation mode** (below), not a single-transcript reflect: a repeated-failure pattern's signature often only shows up in the *shape* of many transcripts (a burst of sessions across several machines within minutes of each other), which no single transcript can reveal on its own.

Skip when the conversation is trivial, off-topic, or already covered by a skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the transcript(s)

**Single-transcript mode (default).** Claude Code stores session transcripts as JSONL under `~/.claude/projects/<encoded-cwd>/*.jsonl`, where `<encoded-cwd>` is the absolute working directory with every `/` replaced by `-` (e.g. `/Users/x/repo` → `-Users-x-repo`). Take the most recently modified file in that directory unless the user names a different project or session. Each line is JSON with a `type` field (`"user"` / `"assistant"` carry the conversation; skip other types like `mode` or `file-history-snapshot`); message text is at `.message.content`, either a plain string or a list of blocks (`text`, `thinking`, `tool_use`, `tool_result`).

A transcript's last turn is not guaranteed to reflect the task's actual final outcome — an Invoker-orchestrated task's finalize/commit step can happen outside the agent's own captured session (e.g. a session that ends mid-`Monitor`-wait on a backgrounded test, with the resulting commit and passing verification appearing only in `git log`, never in that JSONL). Corroborate completion against `git log`/the task's recorded summary before treating a transcript's tail as proof the work finished, succeeded, or failed.

**Multi-conversation mode.** Use `skills/reflect/scripts/corpus_scan.py <keyword-regex> --hours N` when the question spans time or machines instead of one session — it is the tool version of the manual "find matching files, grep them, run token_audit, bucket by time" process, built after doing that by hand once revealed two costly failure modes worth never repeating: a Python regex with unbounded quantifiers (`.{0,80}...`) run against a whole multi-MB transcript read into one string can peg a CPU core for 15+ minutes with zero observable progress (use `grep -c`, not `re.findall`, for keyword/signal counting — see the script's own docstring), and piping a long driver through `| tail -N` (no `-f`) hides all progress until the process exits, making a slow-but-fine run indistinguishable from a hung one.

Local-only is the default and needs no confirmation: `python3 skills/reflect/scripts/corpus_scan.py "e2e|playwright|ci-regression" --hours 24`. It writes a structured JSON (one row per matched session: host, kind, timestamps, tool-error counts, and configurable keyword-signal counts) plus a stdout summary bucketed by host × 15-minute window — that bucketing is where a **dispatch-burst pattern** (several machines starting near-identical sessions within the same few minutes, the actual fingerprint of retry/dedup-gap churn, as opposed to independently-occurring flakiness) becomes visible at a glance instead of buried in a hundred-plus rows.

To also cover the DigitalOcean/SSH remote targets in `~/.invoker/config.json`, add `--include-remote all` (or a comma-separated subset). Without `--confirm-remote-scan` it only *prints* the exact `ssh`/`find`/`grep` command it would run per target and exits — this is deliberate and matches this skill's existing remote-scan policy (see step 2): a confirmation to scan remote hosts, given before the exact command exists, authorizes the *scope*, not the *payload*, so show the printed command to the user once before re-running with `--confirm-remote-scan`. The remote command is read-only (`find` + `grep -l`, nothing destructive, nothing that writes on the remote host) and pulls only files that already matched the keyword, via `scp`, into `--pull-dir` (default `/tmp/reflect-corpus-pull`) for local auditing — nothing is left running on the remote host afterward.

Feed `corpus_scan.py`'s output JSON to the same lens fan-out in step 3 below in place of a single transcript path — give each reviewer the aggregate JSON (not 100+ raw transcripts) plus the specific file paths for anything they want to read in full.

### 2. Run the cost audit, then spawn parallel reviewers

Token usage is exact data sitting in every transcript (Claude Code and Codex embed a `usage{}` block per turn; Cursor's local transcripts don't — see below). Don't have an LLM reviewer eyeball the raw JSONL to guess at spend or thrash — that both burns context (the file itself can be multi-MB) and produces unreliable numbers. Run the mechanical counter first, then hand its *output* (small, structured) to the Cost lens:

```
python3 skills/reflect/scripts/token_audit.py claude <path-to-session.jsonl>
python3 skills/reflect/scripts/token_audit.py codex  <path-to-rollout.jsonl>
python3 skills/reflect/scripts/token_audit.py omp    <path-to-omp-session.jsonl>
python3 skills/reflect/scripts/token_audit.py cursor <path-to-agent-transcript.jsonl>
python3 skills/reflect/scripts/token_audit.py remotes   # names only, from ~/.invoker/config.json if present
```

It reports, per session: total tokens by category and cache-read share, turns whose only tool calls were Read/Grep/Glob (model-tier downgrade candidates), redundant re-reads of an unchanged file, tool errors, cache-creation spikes (a fresh multi-hundred-KB cache write mid-session, instead of a cache read, usually means context got dropped/rebuilt rather than genuinely new information arriving — worth checking what preceded it), and per-turn token growth (a session where each successive turn costs more than the last, because the whole growing history gets resent every turn, burns quota fast even at a high cache-hit rate — this is the main thing to check when a session "ran out" quickly).

**Same-problem thrash, not just literal duplication.** A session can be stuck on one problem while every tool call is technically distinct — each Edit is different text, so the exact-duplicate detector above sees nothing. `token_audit.py` (Claude mode) also flags two shapes of this, both heuristic: (1) **recurring failure signatures** — tool errors whose text repeats (numbers normalized out) across more than one attempt, meaning the same failure keeps recurring rather than getting fixed; genuine user tool-rejections are excluded, since those are the user redirecting, not the agent failing; (2) **edit streaks without a verification run in between** — three or more `Edit`/`Write` calls to the same file with no intervening `Bash` call shaped like a test/build/lint/typecheck command, meaning the agent kept changing code without checking any of the changes. Both point at the same root cause: no fast feedback loop. The agent isn't failing fast — it's iterating blind and only finding out much later (or never, within the session) whether an attempt worked. Feed these counts to the Judgment lens (step 3) alongside the cost numbers; a session with several recurring-failure groups or a long no-verify edit streak is a stronger, more specific finding than "the agent seemed inefficient" — it names the missing guard (a test/build step the agent should have run sooner, or after every attempt) that would have caught it.

**Cross-tool and cross-machine reach:**
- Claude Code sessions live at `~/.claude/projects/<encoded-cwd>/*.jsonl` (see step 1).
- Codex sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, with per-turn usage under `event_msg` → `payload.type == "token_count"`, and a `rate_limits.primary.used_percent` field on the same event that tracks the account's rolling quota — useful for telling "this session burned quota fast" apart from "the account was already near its cap before this session started."
- OMP sessions live at `~/.omp/agent/sessions/**/*.jsonl` (exclude `merge-clones` / `--private-tmp--` worker dirs — those are automated, not interactive work). Each assistant `message` event carries `usage.input/output/cacheRead/cacheWrite` plus an already-computed `usage.cost.total` in dollars — the richest of the four, no pricing table needed.
- Cursor sessions live at `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`. Verified against real transcripts: these carry no token/usage/model fields at all, so `cursor` mode can only report thrash (redundant tool calls), never token or cost numbers. Say that limitation out loud in the summary rather than silently omitting Cursor's cost line.
- Other machines this user runs agents on are listed (by name only, never by host/IP) in `~/.invoker/config.json` under `remoteTargets`, if that file exists. `token_audit.py remotes` surfaces which target names *could* be scanned over SSH for the same session data. It never SSHes itself — actually reaching into a remote machine is a separate, explicitly-confirmed step (it touches shared infrastructure), not something `reflect` does unprompted. A confirmation to scan remote hosts, given before the exact command exists, authorizes the *scope*, not the *payload* — before fanning a script out over SSH to N hosts, show the exact command or script once so the user has actually seen what ran, even if you don't re-ask for approval on every host.

**Pay attention to the tails, not the average.** Real waste concentrates in a handful of outlier sessions, not the typical one. Before (or alongside) auditing the session at hand, run `python3 skills/reflect/scripts/top_sessions.py [N]` — it scans every local Claude/Codex/OMP session (Cursor excluded, no token data there) and ranks them by total tokens. On this machine that's ~15,000 files and finishes in well under a minute. Investigate the top few with `token_audit.py claude|codex|omp <path>` before spending review time on an average session — a 3,000-turn outlier can carry 60+ tool errors and a dozen multi-hundred-K-token cache-rebuild spikes where a clean session has 2 errors and 1 spike. Don't silently cap this to "top 5 and done" — say how many sessions were scanned and how many were outliers worth a look.

`top_sessions.py`'s ranking is still a **triage signal, not a final dollar figure**, even though `scan_claude` already applies the same message.id dedup `token_audit.py` does (verified: `top_sessions.py:20-38`, and `TestTopSessionsScanFunctions.test_scan_claude_dedupes_by_message_id`) — it's a fast, no-cost-model raw token sum, with no cache-read-vs-write pricing and no per-turn detail. Good enough to say "look here first," not a substitute for `token_audit.py`'s fuller output on whatever it flags.

A corpus-wide `top_sessions.py` pass is what actually surfaced a real, multi-week cross-session thrash pattern (the admin-bypass/e2e-worker Mergify repair loop) that a targeted keyword search alone would have missed — confirming evidence for the "periodically worth doing by hand" cadence above, not a reason to add a cron: this remains a manual, occasional pass by design (see the multi-conversation-mode section above on why remote/automated scanning stays an explicit, confirmed step).

**Model-tier backtest.** `model_tier_savings()` in `token_audit.py` prices the flagged lookup-only turns' output tokens at the session's actual model vs. `claude-haiku-4-5`, using published list prices (`PRICING` dict in the script) — a real, reproducible dollar figure, not a guess. It only prices the output side (input/cache-read tokens aren't tracked per-turn), so treat it as a lower bound and say so. This does not verify a cheaper model would have produced the *same result* — that would require actually re-running the turn, which this script doesn't do. If the user wants that verified, say so explicitly rather than implying the $ figure proves equivalence.

**Tests.** `skills/reflect/scripts/tests/test_token_audit.py` covers the dedup fix (the single most important correctness property — get it wrong and every total is inflated 2-3x), redundant-read detection, error detection, the two same-problem-thrash detectors (recurring failure signatures, edit streaks without a verification run), the savings calculation, and both scripts' per-tool scan functions, using small synthetic fixtures (never real user transcripts, so the tests stay portable). `skills/reflect/scripts/tests/test_corpus_scan.py` covers the multi-conversation script separately: it locks down that `remote_scan_command`'s printed output is byte-for-byte what would actually execute (the "show the exact command" transparency guarantee), that it's read-only (no write/exfil commands, no `>` redirect besides `2>/dev/null`), and that `bucket_summary` correctly flags a same-window multi-host burst. Run either with `python3 -m unittest discover -s skills/reflect/scripts/tests -v`. Extend the matching file — don't create additional test files — when adding new detection logic to either script.

### 3. Spawn parallel reviewers

One message, parallel `Agent` calls (`subagent_type: general-purpose`), each given the transcript path (plus the cost-audit output for the Cost lens, and the git log for the History lens) and a distinct lens:

| Lens | Looks for |
|---|---|
| Judgment | Where the reasoning or approach wobbled — a wrong assumption, a fix that didn't address the real cause, scope that crept. Given the `token_audit.py` recurring-failure and no-verify-streak counts (see step 2): did the session get stuck re-attempting the same problem, and if so, why — no fast feedback loop (nothing was run to check an attempt before the next one), or a feedback loop that existed but wasn't fast/cheap enough to actually get used between attempts? Name the missing guard, not just "it thrashed." |
| Tooling | Anything that should have been a script, lint, or runtime check instead of an instruction a human has to remember and re-follow. This is `principle-encode-lessons-in-structure` and `principle-build-the-lever` applied to the session itself. |
| Cost | Given the `token_audit.py` output (not the raw transcript): which flagged items were genuinely avoidable thrash vs. required work (e.g. a Read immediately followed by an Edit on the same file is required by tool semantics, not thrash — a Read repeated with nothing changed in between is). Recommends concrete fixes: delegate a flagged lookup-only turn to a cheaper model or a fork, batch a run of small Edits into fewer passes, investigate a cache-creation spike, stop re-reading a file that didn't change. |
| History | For the files this session touched (especially ones it debugged, reworked, or was corrected on), run `git log --follow -p -- <file>` and `git blame` on the changed lines *before* judging the session in isolation. Check whether an earlier commit — particularly one tagged `Co-Authored-By: Claude` — already introduced this exact bug, papered over the same symptom, or reworked this same area before. A session that "fixed" something we broke ourselves, or that re-solved a problem a past session already solved, is a stronger and more accountable finding than anything visible in the transcript alone — it means a skill or a fix didn't actually stick. |
| Divergent | Whatever the other lenses would miss — an unconventional angle, a blind spot, a pattern that only shows up zoomed out. |

Each reviewer returns candidate learnings as: what happened (with a quote/reference), why it matters, and a suggested routing (edit an existing skill / draft a new skill / add an enforcement script / drop).

Keep each reviewer's prompt to *what happened* — the facts, the audit output, the transcript path — not a pre-digested "here's what's interesting about this session" summary. Priming a reviewer with what to look for narrows what it finds to roughly what you already suspected. Occasionally run `reflect` against a transcript that the audit tooling itself had no hand in building, as a check against home-turf bias — a tool built and debugged inside one session is well-tested on exactly that session's shape and less proven on anything else.

The History lens needs a file list before it can run: pull the set of files the session edited or debugged from the transcript's tool calls (`Edit`/`Write` targets, and files repeatedly `Read` around an error) and pass that list to the reviewer along with the repo path. If the session wasn't in a git repo, or touched no tracked files, skip this lens and say so rather than fabricating history.

### 4. Synthesize

One more `Agent` call, given all reviewers' output, merges overlapping findings and sorts into:

- **Accepted** — real, durable, worth acting on.
- **Backlog** — real, but the right fix is a script/lint/check, not more skill prose. Anything mechanically enforceable belongs here, not in Accepted.
- **Rejected** — one-offs, already covered, or too speculative.
- **Route to `automate-me`** — real, but it's about how *this user* likes to work (response style, delegation habits, verification posture, process conventions) rather than a lesson about the code or task. Don't inline these as edits to a task-specific skill; hand the finding to `automate-me`, which mines across sessions and drafts/updates one personal `<handle>-mode` skill through its own user-facing question pass.

### 5. Get approval — always

Present the full Accepted / Backlog / Route-to-automate-me / Rejected list to the user and wait for explicit approval before touching any file. Skill edits affect every future session — never auto-apply. The user picks which subset to apply and may redirect routings.

### 6. Apply the approved subset

- Trivial edit (a corrected fact, a tightened sentence, a stale example): edit directly.
- Substantive edit (a new section, a new principle, more than ~10 lines): write it out in full, matching the target skill's existing structure and tone, and show the diff before it's considered done.
- Backlog item: describe the concrete script/check/test to write, but don't write it as part of `reflect` itself — that's separate implementation work once the user confirms it's wanted.
- Route-to-`automate-me` item: don't draft it here. Either invoke `automate-me` directly if the user wants it done now, or leave it as a named follow-up in the summary below.

### 7. Summarize

Short list, no preamble:

- Edits applied: `<skill path>` — what changed, one line each.
- New skills created: `<skill path>` — one line each (rare).
- Backlogged: `<what to build>` — one line each, with the evidence that motivated it.
- Routed to `automate-me`: one line each, with the evidence that motivated it.
- Dropped: one line per rejected finding + reason.
- Cost audit: total tokens, cache-read share, and the count of flagged thrash/model-tier items from `token_audit.py` — one line, with the real numbers, not a qualitative impression.
- Feedback-loop check: recurring-failure-signature count and longest no-verify edit streak from `token_audit.py` — one line, with the real numbers; call out explicitly if either was non-zero, since that's the same-problem-thrash signal.
