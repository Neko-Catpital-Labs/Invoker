#!/usr/bin/env bash
set -euo pipefail

coverage_map_file="${1:-}"
source_file="${2:-}"

if [[ -n "$coverage_map_file" ]]; then
  coverage_map="$(cat "$coverage_map_file")"
else
  coverage_map="$(cat)"
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

source_value="null"
if [[ -n "$source_file" ]]; then
  source_value="$(jq -Rn --arg v "$source_file" '$v')"
fi

printf '%s' "$coverage_map" | jq --argjson sourceFile "$source_value" '
  {
    sourceFile: $sourceFile,
    workflows: (
      [
        (.mappings // [])[]?.workflowLabels[]? 
        | select(type == "string")
        | gsub("^\\s+|\\s+$"; "")
        | select(length > 0)
      ]
      | unique
      | to_entries
      | map({
          label: .value,
          planFile: "",
          order: (.key + 1)
        })
    )
  }
'
