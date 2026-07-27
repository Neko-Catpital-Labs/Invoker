#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

REPO="Neko-Catpital-Labs/Invoker"
STATE_FILE="${HOME}/.invoker/slack-complaint-scout-state.jsonl"
AUTHOR_ID="${SLACK_COMPLAINT_SCOUT_AUTHOR_ID:-U0ALGQ64HMF}"
CHANNELS_CSV="${SLACK_COMPLAINT_SCOUT_CHANNEL_IDS:-}"
RUN_LOCAL_CHECK=true
SKIP_LIVE=false
TARGETS=()

usage() {
  cat <<'EOF'
Usage: bash scripts/slack-complaint-scout-driver.sh [options]

One bounded inspection pass for the Slack complaint scout. It does not submit
an Invoker workflow or post to Slack.

Options:
  --skip-local-check      Skip deterministic fixture verification.
  --skip-live             Use fixtures only; never call Slack.
  --target <fingerprint>  Print only this complaint fingerprint. Repeatable.
  --state-file <path>     Override the scout ledger path.
  --repo <owner/repo>     Override the displayed repository name.
  --author <slack-user>   Override the complaint author. Default: Edbert.
  --channel <channel-id>  Add a live Slack channel. Repeatable.
  --help                  Show this message.
EOF
}

declare -a CHANNELS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-local-check) RUN_LOCAL_CHECK=false; shift ;;
    --skip-live) SKIP_LIVE=true; shift ;;
    --target)
      [[ $# -ge 2 ]] || { echo "Missing value for --target" >&2; exit 1; }
      TARGETS+=("$2")
      shift 2
      ;;
    --state-file)
      [[ $# -ge 2 ]] || { echo "Missing value for --state-file" >&2; exit 1; }
      STATE_FILE="$2"
      shift 2
      ;;
    --repo)
      [[ $# -ge 2 ]] || { echo "Missing value for --repo" >&2; exit 1; }
      REPO="$2"
      shift 2
      ;;
    --author)
      [[ $# -ge 2 ]] || { echo "Missing value for --author" >&2; exit 1; }
      AUTHOR_ID="$2"
      shift 2
      ;;
    --channel)
      [[ $# -ge 2 ]] || { echo "Missing value for --channel" >&2; exit 1; }
      CHANNELS+=("$2")
      shift 2
      ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 1 ;;
  esac
done

if [[ -n "$CHANNELS_CSV" ]]; then
  IFS=',' read -r -a configured_channels <<<"$CHANNELS_CSV"
  CHANNELS+=("${configured_channels[@]}")
fi

if ((${#CHANNELS[@]} == 0)) && [[ -n "${SLACK_CHANNEL_ID:-}" ]]; then
  CHANNELS+=("$SLACK_CHANNEL_ID")
fi

echo "== loop context =="
echo "pwd: $PWD"
echo "branch: $(git branch --show-current)"
echo "repo: $REPO"
echo "ledger: $STATE_FILE"
echo "author: $AUTHOR_ID"
echo "channels: ${CHANNELS[*]:-none}"
echo

fixture="scripts/repro/fixtures/slack-complaint-scout/messages.json"
fixture_targets="[]"
if [[ "$RUN_LOCAL_CHECK" == true ]]; then
  echo "== deterministic local proxy =="
  fixture_targets="$(python3 scripts/slack-complaint-scout-discover.py --fixture "$fixture" --author "$AUTHOR_ID")"
  python3 - "$fixture_targets" <<'PY'
import json
import sys

targets = json.loads(sys.argv[1])
assert len(targets) == 1, targets
assert targets[0]["productArea"] == "slack_receiver", targets
print("PASS: fixture classifier yields exactly one Slack receiver complaint")
PY
fi

if [[ "$SKIP_LIVE" == true ]]; then
  if [[ "$RUN_LOCAL_CHECK" == false ]]; then
    fixture_targets="$(python3 scripts/slack-complaint-scout-discover.py --fixture "$fixture" --author "$AUTHOR_ID")"
  fi
  live_targets="$fixture_targets"
else
  [[ -f "${HOME}/.invoker/.slack-owner.env" ]] || {
    echo "Missing ${HOME}/.invoker/.slack-owner.env for live Slack inspection" >&2
    exit 1
  }
  [[ ${#CHANNELS[@]} -gt 0 ]] || {
    echo "No live Slack channels configured; pass --channel or set SLACK_COMPLAINT_SCOUT_CHANNEL_IDS" >&2
    exit 1
  }
  set -a
  source "${HOME}/.invoker/.slack-owner.env"
  set +a
  discover_args=(--author "$AUTHOR_ID")
  for channel in "${CHANNELS[@]}"; do
    discover_args+=(--channel "$channel")
  done
  live_targets="$(python3 scripts/slack-complaint-scout-discover.py "${discover_args[@]}")"
fi

echo
echo "== live complaint targets =="
python3 - "$live_targets" "${TARGETS[@]}" <<'PY'
import json
import sys

targets = json.loads(sys.argv[1])
requested = set(sys.argv[2:])
for target in targets:
    if requested and target["issueFingerprint"] not in requested:
        continue
    print(
        f"{target['issueFingerprint']}: area={target['productArea']} "
        f"channel={target['channelId']} thread={target['threadTs']}"
    )
    print(f"  complaint: {target['text']}")
if not targets:
    print("none")
PY

echo
echo "== ledger fail-condition summary (3+ attempts per fingerprint) =="
ledger_copy="$(mktemp "${TMPDIR:-/tmp}/slack-complaint-scout-ledger.XXXXXX")"
trap 'rm -f "$ledger_copy"' EXIT
if [[ -f "$STATE_FILE" ]]; then
  cp "$STATE_FILE" "$ledger_copy"
else
  : >"$ledger_copy"
fi
python3 - "$live_targets" "$ledger_copy" <<'PY'
import json
import pathlib
import sys
from collections import Counter

targets = {row["issueFingerprint"] for row in json.loads(sys.argv[1])}
counts = Counter()
for raw in pathlib.Path(sys.argv[2]).read_text().splitlines():
    try:
        row = json.loads(raw)
    except json.JSONDecodeError:
        continue
    fingerprint = row.get("issueFingerprint")
    if fingerprint in targets:
        counts[fingerprint] += 1
for fingerprint, count in sorted(counts.items()):
    if count >= 3:
        print(f"FAIL_CONDITION fingerprint={fingerprint} attempts={count}")
if not any(count >= 3 for count in counts.values()):
    print("none")
PY

echo
echo "== approval-gated reminder =="
echo "Success is an existing Slack Approve/Cancel plan draft or one exact human-only blocker."
echo "This driver never calls start_plan, submits a child workflow, or posts to Slack."
