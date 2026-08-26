# 05 — AES-GCM rewrite persistence and schema

## Goal
Add Postgres-backed encrypted rewrite run storage.

## Acceptance criteria
- Schema for rewrite runs with status, ciphertext payload, expiry, attempts, and redacted audit fields.
- AES-256-GCM encrypt/decrypt helpers using `EMPATHY_RUN_ENCRYPTION_KEY`.
- Inserts store ciphertext only; plaintext never persisted.
- Unit tests cover round-trip encryption and schema helpers with a test DB or in-memory double.

## Non-goals
- No full claim/retry executor yet.
- No social campaign tables.
