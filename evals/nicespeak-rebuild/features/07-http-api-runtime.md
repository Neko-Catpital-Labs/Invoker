# 07 — Health/rewrite HTTP API, CORS, local runtime

## Goal
Expose `GET /health` and `POST /v1/rewrite` over a local Node runtime with CORS and no-store responses.

## Acceptance criteria
- `/health` returns ok.
- `/v1/rewrite` is public (no bearer required), validates inbound, runs durable lifecycle, returns plaintext only on the response with `Cache-Control: no-store`.
- CORS allows Slack Web, Google Chat, and configured origins.
- Local server reads env from the shell (`.env` template optional; not auto-loaded).
- Tests cover routing, CORS, and fail-closed validation.

## Non-goals
- Vercel adapters and cron come later.
- Social portal routes are out of scope for the pilot.
