# 08 — Shared browser review state machine

## Goal
Implement the browser review state machine shared by future Slack/Google Chat UIs.

## Acceptance criteria
- States cover idle → rewriting → reviewing → sending/cancelled/failed.
- Accept rewrite and keep original transitions are explicit.
- Rewrite failures never auto-send the original.
- YOLO auto-send remains unavailable (hard-disabled).
- Unit tests cover transitions and duplicate-submit prevention.

## Non-goals
- No DOM adapters yet.
- Do not enable YOLO.
