#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-}"

if ! command -v glab >/dev/null 2>&1; then
  echo "prove-gitlab-forge-live: glab is required (brew install glab)" >&2
  exit 1
fi

if ! glab api user >/dev/null 2>&1; then
  echo "prove-gitlab-forge-live: glab is not authenticated." >&2
  echo "Run: glab auth login" >&2
  echo "Or export GITLAB_TOKEN / GLAB_TOKEN for gitlab.com." >&2
  exit 1
fi

export INVOKER_GITLAB_LIVE=1
export GIT_TERMINAL_PROMPT=0
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='credential.https://gitlab.com.helper'
export GIT_CONFIG_VALUE_0='!glab auth git-credential'
if [[ -n "${INVOKER_GITLAB_PROJECT:-}" ]]; then
  echo "prove-gitlab-forge-live: using INVOKER_GITLAB_PROJECT=${INVOKER_GITLAB_PROJECT}"
else
  echo "prove-gitlab-forge-live: INVOKER_GITLAB_PROJECT unset; test will create a private throwaway project"
fi

cd "$ROOT/packages/execution-engine"
pnpm exec vitest run src/__tests__/gitlab-merge-gate-provider.live.test.ts
