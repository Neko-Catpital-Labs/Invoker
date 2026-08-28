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
RUN_STDOUT="$TMP_DIR/run.stdout"
RUN_STDERR="$TMP_DIR/run.stderr"

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

printf 'preprovisioned pnpm workspace marker\n' > "$FAKE_ROOT/node_modules/.modules.yaml"
printf 'lockfileVersion: 9.0\n' > "$FAKE_ROOT/pnpm-lock.yaml"
touch -t 202001010000 "$FAKE_ROOT/pnpm-lock.yaml"
touch -t 202001010001 "$FAKE_ROOT/node_modules/.modules.yaml"

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

run_fake_headless() {
  local force_bootstrap="${1:-0}"
  rm -f "$PNPM_CALLS" "$RUN_STDOUT" "$RUN_STDERR"
  status=0
  HOME="$TMP_DIR/home" \
    INVOKER_FORCE_BOOTSTRAP="$force_bootstrap" \
    INVOKER_DB_DIR="$TMP_DIR/db" \
    INVOKER_REPO_CONFIG_PATH="$TMP_DIR/config.json" \
    INVOKER_REPRO_PNPM_CALLS="$PNPM_CALLS" \
    PATH="$STUB_BIN:$PATH" \
    "$FAKE_ROOT/run.sh" --headless delete-all >"$RUN_STDOUT" 2>"$RUN_STDERR" || status=$?
}

pnpm_call_count() {
  if [[ -f "$PNPM_CALLS" ]]; then
    wc -l < "$PNPM_CALLS" | tr -d '[:space:]'
  else
    printf '0\n'
  fi
}

assert_pnpm_install_attempted() {
  local reason="$1"
  local count
  count="$(pnpm_call_count)"
  if [[ "$count" -lt 1 ]]; then
    echo "repro: expected run.sh to call pnpm for $reason" >&2
    echo "stdout:" >&2
    cat "$RUN_STDOUT" >&2 || true
    echo "stderr:" >&2
    cat "$RUN_STDERR" >&2 || true
    exit 1
  fi
  if [[ "$status" -ne 73 ]]; then
    echo "repro: expected pnpm stub exit 73 for $reason, got $status" >&2
    cat "$RUN_STDERR" >&2 || true
    exit 1
  fi
  if ! grep -Fq 'install --frozen-lockfile' "$PNPM_CALLS"; then
    echo "repro: expected pnpm install --frozen-lockfile for $reason, saw:" >&2
    cat "$PNPM_CALLS" >&2 || true
    exit 1
  fi
}

run_fake_headless

if [[ "$EXPECTATION" == "bug" ]]; then
  assert_pnpm_install_attempted "a missing bootstrap stamp"
  echo "repro: confirmed bug"
  echo "repro: healthy artifacts were present, bootstrap stamp was absent, and run.sh called pnpm install"
  cat "$PNPM_CALLS"
else
  if [[ "$(pnpm_call_count)" -ne 0 ]]; then
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

  run_fake_headless 1
  assert_pnpm_install_attempted "INVOKER_FORCE_BOOTSTRAP=1"

  touch -t 202001010002 "$FAKE_ROOT/pnpm-lock.yaml"
  run_fake_headless
  assert_pnpm_install_attempted "a stale install metadata timestamp"

  echo "repro: confirmed fixed behavior"
fi
