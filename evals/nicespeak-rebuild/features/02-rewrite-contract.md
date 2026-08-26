# 02 — Rewrite request/result contract and strict validation

## Goal
Define the shared rewrite JSON contract and fail-closed inbound/outbound validation.

## Contract
Request (`POST /v1/rewrite` body):
- `text` (required string)
- optional `persona` defaulting to `corporate`
- optional allowlisted `customization`: `brevity` (`short`|`normal`), `preserveEmoji` (boolean)
- optional `context` with allowlisted keys only (`app`, `surface`, `workspaceId`, `conversationId`, `channelName`)

Response:
- `acceptable` boolean
- `categories` string array
- `original`, `replacement`
- `policyVersion`, `provider`

## Acceptance criteria
- Pure validation module rejects unknown fields and free-text overlay prompts.
- Valid requests pass; invalid requests fail before any provider call.
- Unit tests cover allowlist and rejection cases without needing a live model.

## Non-goals
- No HTTP server, persistence, or LLM adapters yet.
