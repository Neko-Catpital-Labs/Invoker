#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMON_SH="${INVOKER_E2E_COMMON_SH:-$ROOT/scripts/e2e-dry-run/lib/common.sh}"
source "$COMMON_SH"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

test_retries_wal_guard_once() {
  local tmp repo stdout_file stderr_file attempts_file output
  tmp="$(mktemp -d)"
  repo="$tmp/repo"
  stdout_file="$tmp/stdout"
  stderr_file="$tmp/stderr"
  attempts_file="$tmp/attempts"
  mkdir -p "$repo"
  : > "$attempts_file"
  cat > "$repo/run.sh" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
attempt_file="${INVOKER_TEST_ATTEMPT_FILE:?}"
attempts="$(wc -l < "$attempt_file")"
if [ "$attempts" -eq 0 ]; then
  printf 'first\n' >> "$attempt_file"
  echo 'Read-only file open refused while WAL sidecars exist' >&2
  exit 1
fi
printf 'second\n' >> "$attempt_file"
printf 'ok\n'
EOF
  chmod +x "$repo/run.sh"

  output="$(
    sleep() { :; }
    INVOKER_E2E_REPO_ROOT="$repo"
    INVOKER_TEST_ATTEMPT_FILE="$attempts_file"
    export INVOKER_E2E_REPO_ROOT INVOKER_TEST_ATTEMPT_FILE
    invoker_e2e_run_headless query tasks --output json >"$stdout_file" 2>"$stderr_file"
    cat "$stdout_file"
  )" || fail "expected WAL-boundary retry to succeed"

  [ "$output" = "ok" ] || fail "expected retried command stdout to be ok"
  [ "$(wc -l < "$attempts_file")" -eq 2 ] || fail "expected exactly two headless attempts"
  grep -Fq 'WARN: headless command hit owner-boundary WAL guard, retrying once:' "$stderr_file" \
    || fail "expected WAL-boundary retry warning"

  rm -rf "$tmp"
}

test_ignores_electron_helper_processes() {
  local count
  count="$(
    pgrep() { printf '100\n101\n'; }
    invoker_e2e_pid_cmdline() {
      case "$1" in
        100) printf '/Applications/Invoker.app/electron --headless\n' ;;
        101) printf '/Applications/Invoker.app/Electron Helper --type=renderer --headless\n' ;;
        *) return 1 ;;
      esac
    }
    invoker_e2e_pid_has_env() { return 0; }
    INVOKER_DB_DIR='/tmp/invoker-e2e-db'
    export INVOKER_DB_DIR
    invoker_e2e_count_owned_headless_processes
  )"
  [ "$count" = "1" ] || fail "expected helper process to be ignored, got count=$count"
}

test_waits_for_owned_process_exit() {
  local calls_file
  calls_file="$(mktemp)"
  printf '0\n' > "$calls_file"
  (
    sleep() { :; }
    invoker_e2e_count_owned_headless_processes() {
      local calls
      calls="$(cat "$calls_file")"
      if [ "$calls" -eq 0 ]; then
        printf '1\n' > "$calls_file"
        printf '1'
        return 0
      fi
      printf '0'
    }
    invoker_e2e_assert_no_owned_headless_processes 0 2
  ) || fail "expected helper to wait for a transient owned process to exit"
  [ "$(cat "$calls_file")" = "1" ] || fail "expected wait loop to poll at least once"
  rm -f "$calls_file"
}

test_detects_stale_app_ui_build_artifacts() {
  local tmp repo
  tmp="$(mktemp -d)"
  repo="$tmp/repo"
  mkdir -p \
    "$repo/packages/app/dist" \
    "$repo/packages/app/src" \
    "$repo/packages/ui/dist" \
    "$repo/packages/ui/src"
  : > "$repo/package.json"
  : > "$repo/pnpm-lock.yaml"
  : > "$repo/packages/app/package.json"
  : > "$repo/packages/app/src/headless-client.ts"
  : > "$repo/packages/ui/package.json"
  : > "$repo/packages/ui/src/App.tsx"
  : > "$repo/packages/app/dist/main.js"
  : > "$repo/packages/app/dist/headless-client.js"
  : > "$repo/packages/ui/dist/index.html"

  touch -t 202001010100 "$repo/package.json" "$repo/pnpm-lock.yaml"
  touch -t 202001010100 "$repo/packages/app/package.json" "$repo/packages/app/src/headless-client.ts"
  touch -t 202001010100 "$repo/packages/ui/package.json" "$repo/packages/ui/src/App.tsx"
  touch -t 202001010101 "$repo/packages/app/dist/main.js"
  touch -t 202001010101 "$repo/packages/app/dist/headless-client.js"
  touch -t 202001010101 "$repo/packages/ui/dist/index.html"

  (
    INVOKER_E2E_REPO_ROOT="$repo"
    export INVOKER_E2E_REPO_ROOT
    invoker_e2e_app_ui_build_is_fresh
  ) || fail "expected fresh build artifacts to be accepted"

  touch -t 202001010102 "$repo/packages/app/src/headless-client.ts"
  if (
    INVOKER_E2E_REPO_ROOT="$repo"
    export INVOKER_E2E_REPO_ROOT
    invoker_e2e_app_ui_build_is_fresh
  ); then
    fail "expected newer app source to stale app/ui build artifacts"
  fi

  rm -rf "$tmp"
}

run_case() {
  case "${1:-all}" in
    wal-guard)
      test_retries_wal_guard_once
      ;;
    helper-count)
      test_ignores_electron_helper_processes
      ;;
    wait-exit)
      test_waits_for_owned_process_exit
      ;;
    build-freshness)
      test_detects_stale_app_ui_build_artifacts
      ;;
    all)
      test_retries_wal_guard_once
      test_ignores_electron_helper_processes
      test_waits_for_owned_process_exit
      test_detects_stale_app_ui_build_artifacts
      ;;
    *)
      fail "unknown test case: ${1:-}"
      ;;
  esac
}

run_case "${1:-all}"

echo 'PASS: headless e2e helper retries WAL guard, ignores Electron helpers, and detects stale builds'
