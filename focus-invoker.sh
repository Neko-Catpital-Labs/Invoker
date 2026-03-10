#!/usr/bin/env bash
# Bring the Invoker Electron window to the foreground.
# Skips Slack windows that happen to contain "Invoker" in the title.

for WINDOW_ID in $(xdotool search --name "Invoker" 2>/dev/null; xdotool search --name "electron" 2>/dev/null); do
  WIN_NAME=$(xdotool getwindowname "$WINDOW_ID" 2>/dev/null)
  # Skip Slack and terminal windows
  if echo "$WIN_NAME" | grep -qiE "slack|terminal|@|Cursor|Studio"; then
    continue
  fi
  echo "$WIN_NAME"
  xdotool windowactivate "$WINDOW_ID"
  exit 0
done

echo "Invoker window not found. Is the app running?"
exit 1
