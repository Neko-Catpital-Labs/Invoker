# 10 — Chrome preview/accept/keep/failure/Enter/settings UX

## Goal
Build the Chrome extension review UI and settings for Slack Web.

## Acceptance criteria
- Manifest V3 content extension targeting Slack Web (and prepared for Google Chat hosts if already scaffolded).
- UI supports rewrite preview, Accept rewrite (then send), Keep original (leave unsent), and failure notices that never send.
- Persisted on/off setting for rewriting; passthrough send when off.
- Enter interception as specified; YOLO remains hard-disabled.
- Package scripts/tests cover UI state and safety.

## Non-goals
- Desktop Electron injector and store listing polish can wait for expansion.
- Do not port NiceSpeak tests; write new tests from this spec.
