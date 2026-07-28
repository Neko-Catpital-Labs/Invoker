#!/usr/bin/env bash
# Write markdown release notes for a daily cut from the git log range.
#
# Usage:
#   bash scripts/generate-daily-release-notes.sh --tag daily-YYYYMMDD --sha <sha> \
#     [--previous-tag daily-YYYYMMDD] --out release/RELEASE_NOTES.md
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

TAG=""
SHA=""
PREVIOUS_TAG=""
OUT_FILE="release/RELEASE_NOTES.md"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tag)
      TAG="${2:?missing tag}"
      shift 2
      ;;
    --sha)
      SHA="${2:?missing sha}"
      shift 2
      ;;
    --previous-tag)
      PREVIOUS_TAG="${2:?missing previous tag}"
      shift 2
      ;;
    --out)
      OUT_FILE="${2:?missing out file}"
      shift 2
      ;;
    -h|--help)
      sed -n '2,8p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 64
      ;;
  esac
done

if [ -z "$TAG" ] || [ -z "$SHA" ]; then
  echo "Usage: bash scripts/generate-daily-release-notes.sh --tag <tag> --sha <sha> [--previous-tag <tag>] [--out <file>]" >&2
  exit 64
fi

short_sha="$(git rev-parse --short "$SHA")"
version="$(node -p "require('./package.json').version")"
date_label="${TAG#daily-}"
pretty_date="${date_label:0:4}-${date_label:4:2}-${date_label:6:2}"

mkdir -p "$(dirname "$OUT_FILE")"

{
  echo "# Invoker daily cut ${pretty_date}"
  echo
  echo "Prerelease build of \`${version}\` from \`${short_sha}\`."
  echo
  echo "Install with \`scripts/install.sh --version ${TAG}\`. Stable \`latest\` installs are unchanged."
  echo
  if [ -n "$PREVIOUS_TAG" ] && git rev-parse -q --verify "refs/tags/${PREVIOUS_TAG}" >/dev/null; then
    echo "## Commits since ${PREVIOUS_TAG}"
    echo
    git log --pretty=format:'- %h %s' "${PREVIOUS_TAG}..${SHA}"
    echo
  else
    echo "## Recent commits"
    echo
    git log --pretty=format:'- %h %s' -n 30 "$SHA"
    echo
  fi
} > "$OUT_FILE"
