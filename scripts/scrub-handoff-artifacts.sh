#!/usr/bin/env bash
set -euo pipefail

usage() {
  printf '%s\n' 'Usage: bash scripts/scrub-handoff-artifacts.sh [--check|--apply|--help]'
  printf '%s\n' '  --check  Report handoff artifacts without changing repository state (default).'
  printf '%s\n' '  --apply  Remove only plans/invoker-handoff.md and plans/invoker-handoff.yaml, then check.'
  printf '%s\n' '  --help   Show this help without changing repository state.'
}

mode=check
if [[ "$#" -gt 1 ]]; then
  usage >&2
  exit 2
fi
if [[ "$#" -eq 1 ]]; then
  case "$1" in
    --check)
      mode=check
      ;;
    --apply)
      mode=apply
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

allowlisted_paths=(
  plans/invoker-handoff.md
  plans/invoker-handoff.yaml
)

if [[ "$mode" == apply ]]; then
  for path in "${allowlisted_paths[@]}"; do
    if [[ -e "$path" || -L "$path" ]]; then
      rm -f -- "$path"
    fi
  done
fi

remaining="$({
  find . -maxdepth 4 \( -name candidates.json -o -name 'research-*.json' -o -name 'lens-*.json' \) \
    ! -path './.git/*' ! -path './node_modules/*' ! -path './scripts/*' ! -path './packages/*' \
    -print || exit $?
  for path in "${allowlisted_paths[@]}"; do
    if [[ -e "$path" || -L "$path" ]]; then
      printf '%s\n' "./$path"
    fi
  done
})"

if [[ -n "$remaining" ]]; then
  printf '%s\n' 'handoff files remain in worktree:' >&2
  printf '%s\n' "$remaining" >&2
  exit 1
fi

printf '%s\n' 'scrub-handoff-artifacts-ok'
