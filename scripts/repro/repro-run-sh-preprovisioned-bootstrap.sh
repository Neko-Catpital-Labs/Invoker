#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
EXPECTATION="fixed"
KEEP_TEMP=false

usage() {
  echo "usage: $0 [--expect-bug|--expect-fixed] [--keep-temp]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-bug)
      EXPECTATION="bug"
      shift
      ;;
    --expect-fixed)
      EXPECTATION="fixed"
      shift
      ;;
    --keep-temp)
      KEEP_TEMP=true
      shift
      ;;
    *)
      usage
      exit 2
      ;;
  esac
done

TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-run-sh-bootstrap-repro.XXXXXX")"
FAKE_ROOT="$TMP_DIR/repo"
STUB_BIN="$TMP_DIR/bin"
PNPM_CALLS="$TMP_DIR/pnpm.calls"
STALE_PNPM_CALLS="$TMP_DIR/pnpm-stale.calls"
FORCE_PNPM_CALLS="$TMP_DIR/pnpm-force.calls"
RUN_STDOUT="$TMP_DIR/run.stdout"
RUN_STDERR="$TMP_DIR/run.stderr"
STALE_RUN_STDOUT="$TMP_DIR/run-stale.stdout"
STALE_RUN_STDERR="$TMP_DIR/run-stale.stderr"
FORCE_RUN_STDOUT="$TMP_DIR/run-force.stdout"
FORCE_RUN_STDERR="$TMP_DIR/run-force.stderr"

cleanup() {
  if [[ "$KEEP_TEMP" == true ]]; then
    echo "temp root: $TMP_DIR"
  else
    rm -rf "$TMP_DIR" 2>/dev/null || true
  fi
}
trap cleanup EXIT

mkdir -p \
  "$FAKE_ROOT/node_modules/.bin" \
  "$FAKE_ROOT/packages/app/node_modules/.bin" \
  "$FAKE_ROOT/packages/app/dist" \
  "$STUB_BIN"

cp "$ROOT_DIR/run.sh" "$FAKE_ROOT/run.sh"

PNPM_LOCK="$FAKE_ROOT/pnpm-lock.yaml"
PNPM_MODULES_METADATA="$FAKE_ROOT/node_modules/.modules.yaml"

printf 'lockfileVersion: 9.0\n' > "$PNPM_LOCK"
touch -t 202001010000 "$PNPM_LOCK"
printf 'preprovisioned pnpm workspace marker\n' > "$PNPM_MODULES_METADATA"
touch -t 202001010001 "$PNPM_MODULES_METADATA"

cat > "$FAKE_ROOT/node_modules/.bin/tsup" <<'SH'
#!/usr/bin/env bash
if [[ "${1:-}" == "--version" ]]; then
  echo "tsup 0.0.0-repro"
  exit 0
fi
exit 0
SH
chmod +x "$FAKE_ROOT/node_modules/.bin/tsup"

cat > "$FAKE_ROOT/packages/app/node_modules/.bin/electron" <<'SH'
#!/usr/bin/env bash
exit 0
SH
chmod +x "$FAKE_ROOT/packages/app/node_modules/.bin/electron"

cat > "$FAKE_ROOT/packages/app/dist/headless-client.js" <<'JS'
#!/usr/bin/env node
console.log('headless client reached')
JS
chmod +x "$FAKE_ROOT/packages/app/dist/headless-client.js"

cat > "$STUB_BIN/pnpm" <<'SH'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "${INVOKER_REPRO_PNPM_CALLS:?}"
echo "pnpm stub invoked: $*" >&2
exit 73
SH
chmod +x "$STUB_BIN/pnpm"

if [[ -e "$FAKE_ROOT/node_modules/.invoker-bootstrap-stamp" ]]; then
  echo "repro setup error: bootstrap stamp unexpectedly exists in temp fixture" >&2
  exit 1
fi

RUN_STATUS=0
run_headless_delete_all() {
  local calls_file="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  local force_bootstrap="${4:-0}"

  rm -f "$calls_file"
  RUN_STATUS=0
  HOME="$TMP_DIR/home" \
    INVOKER_DB_DIR="$TMP_DIR/db" \
    INVOKER_FORCE_BOOTSTRAP="$force_bootstrap" \
    INVOKER_REPO_CONFIG_PATH="$TMP_DIR/config.json" \
    INVOKER_REPRO_PNPM_CALLS="$calls_file" \
    PATH="$STUB_BIN:$PATH" \
    "$FAKE_ROOT/run.sh" --headless delete-all >"$stdout_file" 2>"$stderr_file" || RUN_STATUS=$?
}

count_pnpm_calls() {
  local calls_file="$1"
  if [[ -f "$calls_file" ]]; then
    wc -l < "$calls_file" | tr -d '[:space:]'
  else
    echo 0
  fi
}

assert_pnpm_install_attempted() {
  local calls_file="$1"
  local stdout_file="$2"
  local stderr_file="$3"
  local status="$4"
  local context="$5"
  local pnpm_call_count
  pnpm_call_count="$(count_pnpm_calls "$calls_file")"

  if [[ "$pnpm_call_count" -lt 1 ]]; then
    echo "repro: expected run.sh to call pnpm for $context" >&2
    echo "stdout:" >&2
    cat "$stdout_file" >&2 || true
    echo "stderr:" >&2
    cat "$stderr_file" >&2 || true
    exit 1
  fi
  if [[ "$status" -ne 73 ]]; then
    echo "repro: expected pnpm stub exit 73 for $context, got $status" >&2
    cat "$stderr_file" >&2 || true
    exit 1
  fi
  if ! grep -Fq 'install --frozen-lockfile' "$calls_file"; then
    echo "repro: expected pnpm install --frozen-lockfile for $context, saw:" >&2
    cat "$calls_file" >&2 || true
    exit 1
  fi
}

run_headless_delete_all "$PNPM_CALLS" "$RUN_STDOUT" "$RUN_STDERR"
status="$RUN_STATUS"
pnpm_call_count="$(count_pnpm_calls "$PNPM_CALLS")"

if [[ "$EXPECTATION" == "bug" ]]; then
  assert_pnpm_install_attempted "$PNPM_CALLS" "$RUN_STDOUT" "$RUN_STDERR" "$status" "a healthy install with a missing bootstrap stamp"
  echo "repro: confirmed bug"
  echo "repro: healthy artifacts were present, bootstrap stamp was absent, and run.sh called pnpm install"
  cat "$PNPM_CALLS"
else
  if [[ "$pnpm_call_count" -ne 0 ]]; then
    echo "repro: expected fixed run.sh to skip pnpm for healthy preprovisioned artifacts" >&2
    cat "$PNPM_CALLS" >&2 || true
    exit 1
  fi
  if [[ "$status" -ne 0 ]]; then
    echo "repro: expected fixed run.sh to reach the headless client, got exit $status" >&2
    cat "$RUN_STDOUT" >&2 || true
    cat "$RUN_STDERR" >&2 || true
    exit 1
  fi
  if ! grep -Fq 'headless client reached' "$RUN_STDOUT"; then
    echo "repro: fixed-mode run did not reach the headless client" >&2
    cat "$RUN_STDOUT" >&2 || true
    exit 1
  fi

  touch -t 202001010002 "$PNPM_LOCK"
  run_headless_delete_all "$STALE_PNPM_CALLS" "$STALE_RUN_STDOUT" "$STALE_RUN_STDERR"
  assert_pnpm_install_attempted "$STALE_PNPM_CALLS" "$STALE_RUN_STDOUT" "$STALE_RUN_STDERR" "$RUN_STATUS" "a lockfile newer than pnpm installed metadata"

  touch -t 202001010000 "$PNPM_LOCK"
  touch -t 202001010001 "$PNPM_MODULES_METADATA"
  run_headless_delete_all "$FORCE_PNPM_CALLS" "$FORCE_RUN_STDOUT" "$FORCE_RUN_STDERR" 1
  assert_pnpm_install_attempted "$FORCE_PNPM_CALLS" "$FORCE_RUN_STDOUT" "$FORCE_RUN_STDERR" "$RUN_STATUS" "INVOKER_FORCE_BOOTSTRAP=1"

  echo "repro: confirmed fixed behavior"
  echo "repro: healthy preprovisioned install skipped pnpm; stale lockfile and forced bootstrap still invoked pnpm"
fi
