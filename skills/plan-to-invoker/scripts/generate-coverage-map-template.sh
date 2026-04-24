#!/usr/bin/env bash
set -euo pipefail

assumptions_file="${1:-}"

if [[ -n "$assumptions_file" ]]; then
  assumptions="$(cat "$assumptions_file")"
else
  assumptions="$(cat)"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

echo "$assumptions" | jq '{
  sourceKind: (.sourceKind // "generic"),
  sourceFile: (.sourceFile // null),
  mappings: [
    (.coverageItems // [])[] |
    {
      coverageKey,
      rowType,
      mustCover: (.mustCover // true),
      workflowLabels: [],
      rationale: ""
    }
  ]
}'
