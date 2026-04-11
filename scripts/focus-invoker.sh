#!/usr/bin/env bash
# Bring the Invoker Electron window to the foreground.
# Skips windows that contain certain app names in the title.
#
# macOS: Uses osascript (AppleScript). Requires Accessibility permissions
#        (System Settings → Privacy & Security → Accessibility) for the
#        terminal app running this script.
# Linux: Uses xdotool.

EXCLUDE_PATTERN="Chrome|Slack|Cursor|Studio|Browser"

OS="$(uname)"

if [ "$OS" = "Darwin" ]; then
  # macOS: use AppleScript to find and activate the Invoker/Electron window
  osascript -e '
    tell application "System Events"
      set procList to every process whose background only is false
      repeat with proc in procList
        try
          set procName to name of proc
          set winList to every window of proc
          repeat with win in winList
            set winTitle to name of win
            if winTitle contains "Invoker" or winTitle contains "electron" then
              -- Skip excluded windows
              if winTitle does not contain "Chrome" and ¬
                 winTitle does not contain "Slack" and ¬
                 winTitle does not contain "Cursor" and ¬
                 winTitle does not contain "Studio" and ¬
                 winTitle does not contain "Browser" then
                set frontmost of proc to true
                return winTitle
              end if
            end if
          end repeat
        end try
      end repeat
    end tell
    error "Invoker window not found"
  ' 2>/dev/null

  if [ $? -eq 0 ]; then
    exit 0
  else
    echo "Invoker window not found. Is the app running?"
    echo "(On macOS, ensure Accessibility permissions are granted to your terminal.)"
    exit 1
  fi

elif [ "$OS" = "Linux" ]; then
  # Linux: use xdotool
  for WINDOW_ID in $(xdotool search --name "Invoker" 2>/dev/null; xdotool search --name "electron" 2>/dev/null); do
    WIN_NAME=$(xdotool getwindowname "$WINDOW_ID" 2>/dev/null)
    if echo "$WIN_NAME" | grep -qiE "$EXCLUDE_PATTERN"; then
      continue
    fi
    echo "$WIN_NAME"
    xdotool windowactivate "$WINDOW_ID"
    exit 0
  done

  echo "Invoker window not found. Is the app running?"
  exit 1

else
  echo "Unsupported OS: $OS"
  exit 1
fi
