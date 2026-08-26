# 06 — Durable claim/retry/failure/TTL/reclaim lifecycle

## Goal
Implement durable rewrite execution lifecycle over encrypted runs.

## Acceptance criteria
- State machine: pending → processing → completed|failed.
- Claim, provider call, encrypt result, mark completed.
- Retry with bounded attempts; stuck processing reclaim; hard-delete expired ciphertext (10-minute TTL).
- Fail closed on invalid provider output.
- Unit/integration tests cover happy path, failure, reclaim, and expiry delete.

## Non-goals
- No public HTTP handler yet.
- No Temporal/Inngest or external workflow SaaS.
