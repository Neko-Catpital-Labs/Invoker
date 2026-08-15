---
name: reflect
description: Mine a conversation transcript — and the commit history of the files it touched — for durable learnings, then route the real ones into concrete skill edits through explicit user approval. Use when the user says reflect, after a complex multi-step task lands cleanly and the recipe is worth keeping, when the agent hit dead ends before finding a working path, or when the user corrected the agent's approach mid-task.
disable-model-invocation: true
---

# Reflect

Mine a transcript for durable learnings, then turn the real ones into skill edits — never silently.

Adapted from `pstack`'s `reflect` (cursor/plugins), rewritten for Claude Code: transcripts live under `~/.claude/projects/`, review fan-out uses the `Agent` tool, and there's no `create-skill` built-in to hand substantive edits to — the parent writes them directly.

## When to invoke

- The user said "reflect."
- A complex task (5+ tool calls) just landed cleanly and the recipe is worth keeping.
- The agent hit dead ends, found the working path, and the path generalizes.
- The user corrected the agent's approach mid-task.
- A non-trivial workflow emerged that isn't captured anywhere.
- It's been a while since the corpus-wide pass (`top_sessions.py` + this skill's lenses across the worst offenders) last ran. No fixed cadence and no cron — just periodically worth doing by hand, since a single pass has reliably turned up real, evidence-backed findings each time so far.

Skip when the conversation is trivial, off-topic, or already covered by a skill the parent followed correctly. One-offs are not learnings.

## Process

### 1. Locate the transcript

Claude Code stores session transcripts as JSONL under `~/.claude/projects/<encoded-cwd>/*.jsonl`, where `<encoded-cwd>` is the absolute working directory with every `/` replaced by `-` (e.g. `/Users/x/repo` → `-Users-x-repo`). Take the most recently modified file in that directory unless the user names a different project or session. Each line is JSON with a `type` field (`"user"` / `"assistant"` carry the conversation; skip other types like `mode` or `file-history-snapshot`); message text is at `.message.content`, either a plain string or a list of blocks (`text`, `thinking`, `tool_use`, `tool_result`).

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

**Cross-tool and cross-machine reach:**
- Claude Code sessions live at `~/.claude/projects/<encoded-cwd>/*.jsonl` (see step 1).
- Codex sessions live at `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, with per-turn usage under `event_msg` → `payload.type == "token_count"`, and a `rate_limits.primary.used_percent` field on the same event that tracks the account's rolling quota — useful for telling "this session burned quota fast" apart from "the account was already near its cap before this session started."
- OMP sessions live at `~/.omp/agent/sessions/**/*.jsonl` (exclude `merge-clones` / `--private-tmp--` worker dirs — those are automated, not interactive work). Each assistant `message` event carries `usage.input/output/cacheRead/cacheWrite` plus an already-computed `usage.cost.total` in dollars — the richest of the four, no pricing table needed.
- Cursor sessions live at `~/.cursor/projects/<project>/agent-transcripts/<uuid>/<uuid>.jsonl`. Verified against real transcripts: these carry no token/usage/model fields at all, so `cursor` mode can only report thrash (redundant tool calls), never token or cost numbers. Say that limitation out loud in the summary rather than silently omitting Cursor's cost line.
- Other machines this user runs agents on are listed (by name only, never by host/IP) in `~/.invoker/config.json` under `remoteTargets`, if that file exists. `token_audit.py remotes` surfaces which target names *could* be scanned over SSH for the same session data. It never SSHes itself — actually reaching into a remote machine is a separate, explicitly-confirmed step (it touches shared infrastructure), not something `reflect` does unprompted. A confirmation to scan remote hosts, given before the exact command exists, authorizes the *scope*, not the *payload* — before fanning a script out over SSH to N hosts, show the exact command or script once so the user has actually seen what ran, even if you don't re-ask for approval on every host.

**Pay attention to the tails, not the average.** Real waste concentrates in a handful of outlier sessions, not the typical one. Before (or alongside) auditing the session at hand, run `python3 skills/reflect/scripts/top_sessions.py [N]` — it scans every local Claude/Codex/OMP session (Cursor excluded, no token data there) and ranks them by total tokens. On this machine that's ~15,000 files and finishes in well under a minute. Investigate the top few with `token_audit.py claude|codex|omp <path>` before spending review time on an average session — a 3,000-turn outlier can carry 60+ tool errors and a dozen multi-hundred-K-token cache-rebuild spikes where a clean session has 2 errors and 1 spike. Don't silently cap this to "top 5 and done" — say how many sessions were scanned and how many were outliers worth a look.

**Model-tier backtest.** `model_tier_savings()` in `token_audit.py` prices the flagged lookup-only turns' output tokens at the session's actual model vs. `claude-haiku-4-5`, using published list prices (`PRICING` dict in the script) — a real, reproducible dollar figure, not a guess. It only prices the output side (input/cache-read tokens aren't tracked per-turn), so treat it as a lower bound and say so. This does not verify a cheaper model would have produced the *same result* — that would require actually re-running the turn, which this script doesn't do. If the user wants that verified, say so explicitly rather than implying the $ figure proves equivalence.

**Tests.** `skills/reflect/scripts/tests/test_token_audit.py` covers the dedup fix (the single most important correctness property — get it wrong and every total is inflated 2-3x), redundant-read detection, error detection, the savings calculation, and both scripts' per-tool scan functions, using small synthetic fixtures (never real user transcripts, so the tests stay portable). Run with `python3 -m unittest discover -s skills/reflect/scripts/tests -v`. Extend this file — don't create a second test file — when adding new detection logic.

### 3. Spawn parallel reviewers

One message, parallel `Agent` calls (`subagent_type: general-purpose`), each given the transcript path (plus the cost-audit output for the Cost lens, and the git log for the History lens) and a distinct lens:

| Lens | Looks for |
|---|---|
| Judgment | Where the reasoning or approach wobbled — a wrong assumption, a fix that didn't address the real cause, scope that crept. |
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

### 5. Get approval — always

Present the full Accepted / Backlog / Rejected list to the user and wait for explicit approval before touching any file. Skill edits affect every future session — never auto-apply. The user picks which subset to apply and may redirect routings.

### 6. Apply the approved subset

- Trivial edit (a corrected fact, a tightened sentence, a stale example): edit directly.
- Substantive edit (a new section, a new principle, more than ~10 lines): write it out in full, matching the target skill's existing structure and tone, and show the diff before it's considered done.
- Backlog item: describe the concrete script/check/test to write, but don't write it as part of `reflect` itself — that's separate implementation work once the user confirms it's wanted.

### 7. Summarize

Short list, no preamble:

- Edits applied: `<skill path>` — what changed, one line each.
- New skills created: `<skill path>` — one line each (rare).
- Backlogged: `<what to build>` — one line each, with the evidence that motivated it.
- Dropped: one line per rejected finding + reason.
- Cost audit: total tokens, cache-read share, and the count of flagged thrash/model-tier items from `token_audit.py` — one line, with the real numbers, not a qualitative impression.
