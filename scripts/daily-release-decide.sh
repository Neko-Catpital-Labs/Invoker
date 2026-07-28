#!/usr/bin/env bash
# Decide whether to cut a daily release from the given tip ref.
#
# Usage:
#   bash scripts/daily-release-decide.sh [--tip <ref>] [--date YYYYMMDD] [--out <file>]
#
# Prints key=value lines (tag, previous_tag, sha, should_run, skip_reason) to stdout
# and, when --out is set, also appends GitHub Actions output lines to that file.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TIP_REF="master"
DATE_UTC=""
OUT_FILE=""

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tip)
      TIP_REF="${2:?missing tip ref}"
      shift 2
      ;;
    --date)
      DATE_UTC="${2:?missing date}"
      shift 2
      ;;
    --out)
      OUT_FILE="${2:?missing out file}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

if [ -z "$DATE_UTC" ]; then
  DATE_UTC="$(date -u +%Y%m%d)"
fi

if ! [[ "$DATE_UTC" =~ ^[0-9]{8}$ ]]; then
  echo "--date must be YYYYMMDD" >&2
  exit 64
fi

tag="daily-${DATE_UTC}"
sha="$(git rev-parse "${TIP_REF}^{commit}")"

previous_tag=""
while IFS= read -r candidate; do
  [ -n "$candidate" ] || continue
  if [ "$candidate" = "$tag" ]; then
    continue
  fi
  previous_tag="$candidate"
  break
done < <(git tag -l 'daily-*' --sort=-version:refname)

should_run=true
skip_reason=""

if git rev-parse -q --verify "refs/tags/${tag}" >/dev/null; then
  should_run=false
  skip_reason="tag ${tag} already exists"
elif [ -n "$previous_tag" ]; then
  previous_sha="$(git rev-parse "${previous_tag}^{commit}")"
  if [ "$previous_sha" = "$sha" ]; then
    should_run=false
    skip_reason="no new commits since ${previous_tag}"
  fi
fi

emit() {
  local key="$1"
  local value="$2"
  printf '%s=%s\n' "$key" "$value"
  if [ -n "$OUT_FILE" ]; then
    printf '%s=%s\n' "$key" "$value" >> "$OUT_FILE"
  fi
}

emit tag "$tag"
emit previous_tag "$previous_tag"
emit sha "$sha"
emit should_run "$should_run"
emit skip_reason "$skip_reason"
