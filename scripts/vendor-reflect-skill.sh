#!/usr/bin/env bash
# Vendors skills/reflect/ from the canonical catstack repo into this repo.
#
# catstack (https://github.com/EdbertChan/catstack) is the source of truth
# for the reflect skill. Invoker keeps a self-contained copy because the
# ci-regression-watch workflow spawns headless tasks on remote SSH pool
# workers that read skills/reflect/SKILL.md straight out of this repo --
# those ephemeral droplets don't have catstack cloned. Run this script
# whenever catstack's reflect skill changes, instead of hand-editing the
# copy here, so the two never silently diverge.
#
# Usage: bash scripts/vendor-reflect-skill.sh [--source <path-to-catstack-checkout>]
set -euo pipefail
cd "$(dirname "$0")/.."

SOURCE="${CATSTACK_PATH:-../catstack}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source) SOURCE="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,12p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

if [ ! -d "$SOURCE/skills/reflect" ]; then
  echo "FAIL: no skills/reflect/ found at $SOURCE" >&2
  echo "Pass --source <path> or set CATSTACK_PATH to a catstack checkout." >&2
  exit 1
fi

SOURCE_SHA="$(git -C "$SOURCE" rev-parse HEAD)"
DIRTY=""
if [ -n "$(git -C "$SOURCE" status --porcelain -- skills/reflect)" ]; then
  DIRTY=" (with uncommitted local changes to skills/reflect)"
fi

rm -rf skills/reflect
mkdir -p skills/reflect
cp -R "$SOURCE/skills/reflect/." skills/reflect/

cat > skills/reflect/.vendor-source.json <<JSON
{
  "source": "catstack",
  "sourceRepo": "https://github.com/EdbertChan/catstack",
  "sourceCommit": "$SOURCE_SHA$DIRTY",
  "vendoredAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
JSON

echo "Vendored skills/reflect/ from $SOURCE @ $SOURCE_SHA$DIRTY"
