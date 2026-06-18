#!/usr/bin/env bash
# Stub gh CLI for e2e-dry-run: no network, instant responses.
# Handles the exact calls made by GitHubMergeGateProvider:
#   - gh api repos/{owner}/{repo}/pulls --method GET -f head=... -f state=open
#   - gh api repos/{owner}/{repo}/pulls --method POST -f base=... -f head=... -f title=... -f body=...
#   - gh api repos/{owner}/{repo}/pulls/N --method PATCH ...
#   - gh pr view N --json state,reviewDecision,url
# All calls logged to $INVOKER_E2E_MARKER_ROOT/gh-calls.log for verification.
set -eu

ROOT="${INVOKER_E2E_MARKER_ROOT:-}"
LOGFILE="${ROOT:+$ROOT/gh-calls.log}"

log_call() {
  if [ -n "$LOGFILE" ]; then
    mkdir -p "$(dirname "$LOGFILE")"
    echo "$*" >>"$LOGFILE"
  fi
}

# Log the full invocation
log_call "gh $*"

# Parse the subcommand
SUBCMD="${1:-}"
shift || true

case "$SUBCMD" in
  pr)
    ACTION="${1:-}"
    shift || true
    case "$ACTION" in
      list)
        echo "ERROR: gh pr list should not be used; use REST gh api pulls lookup" >&2
        exit 1
        ;;
      view)
        # gh pr view N --json state,reviewDecision,url
        PR_NUM="${1:-99}"
        echo '{"state":"OPEN","reviewDecision":null,"url":"https://github.com/test/repo/pull/'"$PR_NUM"'"}'
        ;;
      *)
        echo "{}" ;;
    esac
    ;;
  api)
    # gh api repos/{owner}/{repo}/pulls --method GET/POST ...
    # or gh api repos/{owner}/{repo}/pulls/N --method PATCH ...
    ENDPOINT="${1:-}"
    shift || true
    if echo "$ENDPOINT" | grep -qE 'pulls$'; then
      METHOD="GET"
      prev=""
      for arg in "$@"; do
        if [ "$prev" = "--method" ]; then
          METHOD="$arg"
          break
        fi
        prev="$arg"
      done
      if [ "$METHOD" = "GET" ]; then
        echo '[]'
      else
        echo '{"html_url":"https://github.com/test/repo/pull/99","number":99}'
      fi
    else
      # PATCH — update existing PR
      echo '{}'
    fi
    ;;
  *)
    echo "{}" ;;
esac

exit 0
