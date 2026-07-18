#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_FILE="${1:-release/SHA256SUMS}"
shift || true
if [ -d "$OUT_FILE" ]; then
  OUT_FILE="$OUT_FILE/SHA256SUMS"
fi

if [ "$#" -gt 0 ]; then
  FILES=("$@")
else
  release_dir="$(dirname "$OUT_FILE")"
  FILES=()
  while IFS= read -r file; do
    FILES+=("$file")
  done < <(find "$release_dir" -maxdepth 1 -type f ! -name SHA256SUMS | sort)
fi

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "No release artifacts found" >&2
  exit 1
fi

mkdir -p "$(dirname "$OUT_FILE")"
out_dir="$(cd "$(dirname "$OUT_FILE")" && pwd)"
declare -a FILE_NAMES=()
for file in "${FILES[@]}"; do
  FILE_NAMES+=("$(basename "$file")")
done
if command -v sha256sum >/dev/null 2>&1; then
  (
    cd "$out_dir"
    sha256sum "${FILE_NAMES[@]}"
  ) > "$OUT_FILE"
else
  (
    cd "$out_dir"
    shasum -a 256 "${FILE_NAMES[@]}"
  ) > "$OUT_FILE"
fi

printf '%s\n' "$OUT_FILE"
