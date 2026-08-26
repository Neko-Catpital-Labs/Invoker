# 04 — Local Claude Code provider adapter

## Goal
Add a local Claude Code CLI rewrite provider adapter behind a provider interface.

## Acceptance criteria
- Provider interface accepts validated rewrite input + persona prompt and returns normalized rewrite result.
- Claude Code adapter invokes authenticated local CLI with tools/session persistence disabled for rewrite calls.
- Malformed model output fails closed.
- Adapter is selectable via `LLM_PROVIDER=claude-code` style configuration.
- Unit tests mock the CLI boundary.

## Non-goals
- OpenAI/Anthropic HTTP providers come later.
- No HTTP route wiring yet beyond what prior slices already exported.
