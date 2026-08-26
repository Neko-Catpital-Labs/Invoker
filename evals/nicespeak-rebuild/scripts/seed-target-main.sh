#!/usr/bin/env bash
# Seed nicespeak_invoker with an empty allow-empty main commit if the repo is empty.
set -euo pipefail

REPO_URL="${1:-https://github.com/Neko-Catpital-Labs/nicespeak_invoker.git}"
TMP="$(mktemp -d)"
cleanup() { rm -rf "$TMP"; }
trap cleanup EXIT

git clone "$REPO_URL" "$TMP/repo"
cd "$TMP/repo"

if git rev-parse --verify HEAD >/dev/null 2>&1; then
  echo "TARGET_ALREADY_SEEDED sha=$(git rev-parse HEAD)"
  exit 0
fi

git checkout -B main
mkdir -p .nicespeak-eval
: > .nicespeak-eval/.keep
git add .nicespeak-eval/.keep
git -c user.email="eval@invoker.local" -c user.name="NiceSpeak Eval" commit --allow-empty -m "chore: seed empty main for NiceSpeak rebuild eval"
git push -u origin main
echo "TARGET_SEEDED sha=$(git rev-parse HEAD)"
