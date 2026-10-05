#!/usr/bin/env bash
set -euo pipefail

CLASS="${1:-}"
case "$CLASS" in
  merge-conflict)
    printf '%s\n' 'merge-conflict: FAILED sha=fixture conflicts=3'
    ;;
  test-failure)
    printf '%s\n' 'test-failure: FAILED sha=fixture tests=2'
    ;;
  *)
    echo "usage: $0 merge-conflict|test-failure" >&2
    exit 2
    ;;
esac
