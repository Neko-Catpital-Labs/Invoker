---
name: diu
description: >
  Default communication-brevity rule: before finishing any response, check
  whether it would run over roughly 150 words or lean on unexplained jargon. If
  so, and the user has not explicitly asked for full technical detail in the
  same turn, replace it with an ELI5 answer under 40 words instead. Also
  triggers immediately on a literal ELI5 request in the user's message (eli5,
  ELI5, Eli5, "ELI 5" with a space, or an explicit word cap like "< 40 words"),
  even with no other context. Fires most often on debugging "why" questions,
  architecture explanations, and PR summaries.
---

# diu

## Why this exists

Mined from real Claude Code and Codex CLI session history: the user asks for
"eli5" constantly, almost always proactively in the same message as the
question rather than as a follow-up complaint after a bad answer, most often on
root-cause "why is this broken" debugging questions, architecture explanations,
and PR summaries. See `references/eli5-trigger-corpus.md` for the mined
examples this skill is calibrated against.

## The rule

1. Before sending a response, estimate its length and jargon density.
2. If it would exceed 150 words, or uses terms the user hasn't already used and
   hasn't asked to have explained at that depth, stop and rewrite it as ELI5:
   under 40 words, plain everyday language, lead with the outcome, no
   unexplained acronyms or jargon.
3. Do not apply the ELI5 cap when the user's message explicitly asks for
   technical detail, full depth, or a specific longer format (a PR summary, a
   written plan, a list of files) in that same turn — brevity does not override
   an explicit request for depth.
4. Treat a literal ELI5 request as an immediate override regardless of the
   150-word/jargon check: match case-insensitively on "eli5", "eli 5" (optional
   space before the digit), and "explain like i'm 5" / "explain like i am 5".
   An explicit word cap in the same message (e.g. "< 40 words", "< 50 words")
   sets the ceiling instead of the 40-word default when given.
5. A bare trigger with no other words (e.g. "eli5", "eli5 <link>") still means:
   answer the open question from context, in ELI5 register, under 40 words. Do
   not ask what "it" refers to if the prior turn makes it clear.

## What this looks like

- Root-cause/debugging "why" questions: state the one-line cause and fix in
  plain words, skip the investigation narrative.
- Architecture/design explanations: one sentence on the mechanic, stop unless
  asked how or why.
- PR summaries: outcome in one sentence, cause in one sentence, fix in one
  sentence.
