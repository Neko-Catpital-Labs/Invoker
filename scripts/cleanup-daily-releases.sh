#!/usr/bin/env bash
# Delete GitHub daily-* prereleases (and tags) older than N days.
#
# Usage:
#   bash scripts/cleanup-daily-releases.sh [--days 14] [--repo owner/name] [--dry-run]
#
# Intended for CI (needs gh + GITHUB_TOKEN). Failures are printed but do not
# exit non-zero unless --strict is set.
set -euo pipefail

DAYS=14
REPO="${GITHUB_REPOSITORY:-}"
DRY_RUN=0
STRICT=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --days)
      DAYS="${2:?missing days}"
      shift 2
      ;;
    --repo)
      REPO="${2:?missing repo}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --strict)
      STRICT=1
      shift
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

if [ -z "$REPO" ]; then
  echo "Missing --repo (or GITHUB_REPOSITORY)" >&2
  exit 64
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "gh is required" >&2
  exit 64
fi

if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || [ "$DAYS" -lt 1 ]; then
  echo "--days must be a positive integer" >&2
  exit 64
fi

cutoff="$(date -u -d "${DAYS} days ago" +%Y%m%d 2>/dev/null || date -u -v-"${DAYS}"d +%Y%m%d)"
echo "Deleting daily-* releases with date before ${cutoff} (keep last ${DAYS} days)"

status=0
while IFS=$'\t' read -r tag; do
  [ -n "$tag" ] || continue
  [[ "$tag" =~ ^daily-([0-9]{8})$ ]] || continue
  day="${BASH_REMATCH[1]}"
  if [ "$day" -ge "$cutoff" ]; then
    continue
  fi
  echo "Deleting ${tag}"
  if [ "$DRY_RUN" -eq 1 ]; then
    continue
  fi
  if ! gh release delete "$tag" --repo "$REPO" --yes --cleanup-tag; then
    echo "Failed to delete ${tag}" >&2
    status=1
  fi
done < <(gh release list --repo "$REPO" --limit 100 --json tagName --jq '.[].tagName' | grep -E '^daily-[0-9]{8}$' || true)

if [ "$STRICT" -eq 1 ]; then
  exit "$status"
fi
exit 0
