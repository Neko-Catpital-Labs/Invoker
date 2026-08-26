# 01 — Repository and Node 22 toolchain bootstrap

## Goal
Create a Node 22+ repository skeleton for NiceSpeak rebuild work on an empty `main`.

## Acceptance criteria
- `package.json` exists with `"type": "module"`, `"engines.node": ">=22"`, and scripts `test` and `check`.
- Root README describes how to run the API locally once later features exist.
- `.gitignore` ignores `node_modules/`, `.env`, build outputs, and OS junk.
- `npm test` (or `node --test` via the `test` script) exits 0 with at least one smoke test.
- No product rewrite behavior is implemented in this slice.

## Non-goals
- No Postgres schema, HTTP routes, browser extension, or mobile clients.
- Do not copy or read NiceSpeak source or tests.

## Safety
Fail closed on secrets: do not commit API keys. Leave `.env.example` only if needed later.
