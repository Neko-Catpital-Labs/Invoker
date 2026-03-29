#!/usr/bin/env bash
# Stub gh CLI for e2e-dry-run: no network, instant responses.
# Handles the exact calls made by GitHubMergeGateProvider:
#   - gh pr list --head ... --base ... --state open --json url,number --limit 1
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
        # gh pr list --head ... --base ... --state open --json url,number --limit 1
        # Return empty array (no existing PR)
        echo '[]'
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
    # gh api repos/{owner}/{repo}/pulls --method POST ...
    # or gh api repos/{owner}/{repo}/pulls/N --method PATCH ...
    ENDPOINT="${1:-}"
    shift || true
    if echo "$ENDPOINT" | grep -qE 'pulls$'; then
      # POST — create new PR
      echo '{"html_url":"https://github.com/test/repo/pull/99","number":99}'
    else
      # PATCH — update existing PR
      echo '{}'
    fi
    ;;
  *)
    echo "{}" ;;
esac

exit 0
