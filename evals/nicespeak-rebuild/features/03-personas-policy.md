# 03 — Versioned personas and server-owned policy

## Goal
Implement server-owned persona configs `corporate@v1` and `personable@v1` with clamped overlays.

## Acceptance criteria
- Persona catalog resolves versioned prompts for corporate and personable.
- Request overlays only mutate allowlisted knobs; free-text prompt injection is rejected.
- Fake-door persona IDs never resolve to executable prompts.
- Policy merge order: persona defaults → allowlisted overlays.
- Unit tests cover defaults, overlays, and rejection.

## Non-goals
- No empathy feature-flag gate yet unless required by shared contract stubs.
- No provider network calls.
