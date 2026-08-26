# 09 — Slack Web composer/context/send adapter

## Goal
Detect Slack Web composer, extract conversation context from the URL/DOM, and integrate with the review state machine.

## Acceptance criteria
- Works on `app.slack.com` composers.
- Extracts workspace/conversation/channel context when available.
- Can replace/intercept send controls without sending until Accept.
- Plain Enter triggers review path; Shift+Enter remains newline.
- Unit tests with DOM fakes cover discovery and context extraction.

## Non-goals
- Google Chat adapter comes later.
- No Chrome packaging/store assets yet.
