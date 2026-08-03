#!/usr/bin/env bash
# Deterministic Claude-shaped fullscreen TUI for terminal preservation e2e tests.
set -euo pipefail

printf '\033[2J\033[H'
printf '\033[3;5HClaude Code E2E'
printf '\033[5;5HStable fullscreen Claude fixture'
printf '\033[7;5HThis screen intentionally stays quiet after drawing.'
printf '\033[24;1HCLAUDE_TUI_READY'
sleep "${INVOKER_E2E_CLAUDE_TUI_HOLD_SECS:-20}"
