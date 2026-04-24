#!/usr/bin/env bash
set -euo pipefail

coverage_map_file="${1:?Usage: bash check-stack-manifest.sh <coverage-map.json> <stack-manifest.json> [source-file]}"
stack_manifest_file="${2:?Usage: bash check-stack-manifest.sh <coverage-map.json> <stack-manifest.json> [source-file]}"
source_file="${3:-}"

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

jq -e 'type == "object" and (.mappings | type == "array")' "$coverage_map_file" >/dev/null || {
  echo "coverage map must be an object with a mappings array" >&2
  exit 1
}

jq -e 'type == "object" and (.workflows | type == "array")' "$stack_manifest_file" >/dev/null || {
  echo "stack manifest must be an object with a workflows array" >&2
  exit 1
}

if [[ -n "$source_file" && ! -f "$source_file" ]]; then
  echo "source file not found: $source_file" >&2
  exit 1
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

stack_manifest_dir="$(cd "$(dirname "$stack_manifest_file")" && pwd)"
repo_root=""
if git -C "$stack_manifest_dir" rev-parse --show-toplevel >/dev/null 2>&1; then
  repo_root="$(git -C "$stack_manifest_dir" rev-parse --show-toplevel)"
fi

resolve_path() {
  local candidate="$1"
  if [[ "$candidate" = /* ]]; then
    printf '%s\n' "$candidate"
    return 0
  fi
  if [[ -n "$repo_root" ]]; then
    printf '%s\n' "$repo_root/$candidate"
    return 0
  fi
  printf '%s\n' "$stack_manifest_dir/$candidate"
}

declared_labels="$tmpdir/declared_labels.txt"
manifest_labels="$tmpdir/manifest_labels.txt"
missing_labels="$tmpdir/missing_labels.txt"
unused_labels="$tmpdir/unused_labels.txt"
empty_labels="$tmpdir/empty_labels.txt"
duplicate_labels="$tmpdir/duplicate_labels.txt"
missing_plan_files="$tmpdir/missing_plan_files.txt"
missing_plan_paths="$tmpdir/missing_plan_paths.txt"
source_mismatches="$tmpdir/source_mismatches.txt"
invalid_orders="$tmpdir/invalid_orders.txt"
duplicate_orders="$tmpdir/duplicate_orders.txt"
noncontiguous_orders="$tmpdir/noncontiguous_orders.txt"

jq -r '.mappings[]?.workflowLabels[]? // empty' "$coverage_map_file" | sort -u > "$declared_labels"
jq -r '.workflows[]?.label // empty' "$stack_manifest_file" | sort -u > "$manifest_labels"

comm -23 "$declared_labels" "$manifest_labels" > "$missing_labels" || true
comm -13 "$declared_labels" "$manifest_labels" > "$unused_labels" || true

jq -r '.workflows[]
  | select(((.label // "") | type) != "string" or (((.label // "") | gsub("^\\s+|\\s+$"; "")) | length) == 0)
  | (.planFile // "<unknown-plan>")' "$stack_manifest_file" > "$empty_labels" || true

jq -r '.workflows[]?.label // empty' "$stack_manifest_file" | sort | uniq -d > "$duplicate_labels" || true

jq -r '.workflows[]
  | select(((.planFile // "") | type) != "string" or (((.planFile // "") | gsub("^\\s+|\\s+$"; "")) | length) == 0)
  | (.label // "<unknown-label>")' "$stack_manifest_file" > "$missing_plan_files" || true

jq -r '.workflows[]
  | select((.order | type) != "number" or (.order | floor) != .order or .order < 1)
  | (.label // "<unknown-label>")' "$stack_manifest_file" > "$invalid_orders" || true

jq -r '.workflows[]?.order' "$stack_manifest_file" | sort -n | uniq -d > "$duplicate_orders" || true

python3 - "$stack_manifest_file" > "$noncontiguous_orders" <<'PY'
import json, sys
with open(sys.argv[1]) as f:
    data = json.load(f)
orders = sorted(
    int(w["order"])
    for w in data.get("workflows", [])
    if isinstance(w.get("order"), int) and w["order"] >= 1
)
if not orders:
    sys.exit(0)
expected = list(range(orders[0], orders[0] + len(orders)))
if orders != expected:
    print(f"expected contiguous orders {expected}, got {orders}")
PY

jq -r '.workflows[]
  | select(((.planFile // "") | type) == "string" and (((.planFile // "") | gsub("^\\s+|\\s+$"; "")) | length) > 0)
  | @base64' "$stack_manifest_file" | while IFS= read -r encoded; do
  [[ -n "$encoded" ]] || continue
  row_json="$(printf '%s' "$encoded" | base64 --decode)"
  label="$(printf '%s' "$row_json" | jq -r '.label // "<unknown-label>"')"
  plan_file="$(printf '%s' "$row_json" | jq -r '.planFile')"
  resolved_plan_file="$(resolve_path "$plan_file")"
  if [[ ! -f "$resolved_plan_file" ]]; then
    printf '%s -> %s\n' "$label" "$plan_file" >> "$missing_plan_paths"
  fi
done

if [[ -n "$source_file" ]]; then
  manifest_source="$(jq -r '.sourceFile // empty' "$stack_manifest_file")"
  if [[ -z "$manifest_source" ]]; then
    printf 'stack manifest sourceFile is missing\n' > "$source_mismatches"
  else
    resolved_manifest_source="$(resolve_path "$manifest_source")"
    expected_source="$(cd "$(dirname "$source_file")" && pwd)/$(basename "$source_file")"
    if [[ "$resolved_manifest_source" != "$expected_source" ]]; then
      printf 'expected %s, got %s\n' "$expected_source" "$resolved_manifest_source" > "$source_mismatches"
    fi
  fi
fi

if [[ -s "$empty_labels" ]]; then
  echo "stack manifest workflows must include a non-empty label:" >&2
  sed 's/^/  - /' "$empty_labels" >&2
  exit 1
fi

if [[ -s "$duplicate_labels" ]]; then
  echo "stack manifest workflow labels must be unique:" >&2
  sed 's/^/  - /' "$duplicate_labels" >&2
  exit 1
fi

if [[ -s "$missing_plan_files" ]]; then
  echo "stack manifest workflows must include a non-empty planFile:" >&2
  sed 's/^/  - /' "$missing_plan_files" >&2
  exit 1
fi

if [[ -s "$invalid_orders" ]]; then
  echo "stack manifest workflows must include a positive integer order:" >&2
  sed 's/^/  - /' "$invalid_orders" >&2
  exit 1
fi

if [[ -s "$duplicate_orders" ]]; then
  echo "stack manifest workflow orders must be unique:" >&2
  sed 's/^/  - /' "$duplicate_orders" >&2
  exit 1
fi

if [[ -s "$noncontiguous_orders" ]]; then
  echo "stack manifest workflow orders must be contiguous:" >&2
  sed 's/^/  - /' "$noncontiguous_orders" >&2
  exit 1
fi

if [[ -s "$missing_plan_paths" ]]; then
  echo "stack manifest planFile entries must point to real files:" >&2
  sed 's/^/  - /' "$missing_plan_paths" >&2
  exit 1
fi

if [[ -s "$source_mismatches" ]]; then
  echo "stack manifest sourceFile must match the validated policy source:" >&2
  sed 's/^/  - /' "$source_mismatches" >&2
  exit 1
fi

if [[ -s "$missing_labels" ]]; then
  echo "coverage map references workflow labels not present in the stack manifest:" >&2
  sed 's/^/  - /' "$missing_labels" >&2
  exit 1
fi

if [[ -s "$unused_labels" ]]; then
  echo "stack manifest contains workflow labels that are not referenced by the coverage map:" >&2
  sed 's/^/  - /' "$unused_labels" >&2
  exit 1
fi

echo "true"
