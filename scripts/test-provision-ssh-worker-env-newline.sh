#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/invoker-provision-newline.XXXXXX")"
trap 'rm -rf "$TMP_ROOT"' EXIT

FAILURES=0
fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

HELPERS="$TMP_ROOT/helpers.sh"
sed -n '/^write_file() {/,/^}/p' "$ROOT/scripts/provision-ssh-worker.sh" > "$HELPERS"
if ! grep -q 'write_file()' "$HELPERS"; then
  printf 'FAIL: could not extract write_file() from provision-ssh-worker.sh\n' >&2
  exit 1
fi
DRY_RUN=0
source "$HELPERS"

TARGET="$TMP_ROOT/env.sh"
write_file "$TARGET" "$(printf 'export A="1"\nexport B="2"')"

last_byte="$(tail -c 1 "$TARGET" | od -An -c | tr -d ' \n')"
if [[ "$last_byte" != '\n' ]]; then
  fail "write_file left no trailing newline (last byte: ${last_byte:-EMPTY})"
fi

printf 'export C="3"\n' >> "$TARGET"
line_count="$(wc -l < "$TARGET" | tr -d ' ')"
if [[ "$line_count" != "3" ]]; then
  fail "append spliced onto the previous line: expected 3 lines, got $line_count"
fi

got_b="$(env -i bash -c ". '$TARGET' >/dev/null 2>&1; printf '%s' \"\$B\"")"
if [[ "$got_b" != "2" ]]; then
  fail "appending corrupted the preceding export: B=[$got_b], expected [2]"
fi

MULTI="$TMP_ROOT/multi.sh"
write_file "$MULTI" $'export A="1"\n\n\n'
if ! cmp -s "$MULTI" <(printf 'export A="1"\n'); then
  fail "write_file kept extra trailing newlines: $(od -An -c "$MULTI" | tr -s ' ')"
fi

if (( FAILURES > 0 )); then
  printf '%s: %d failure(s)\n' "$(basename "$0")" "$FAILURES" >&2
  exit 1
fi
printf '%s: OK\n' "$(basename "$0")"
