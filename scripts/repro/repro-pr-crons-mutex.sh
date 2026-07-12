#!/usr/bin/env bash
# Cross-job mutual exclusion proof: while the shared PR-maintenance lock is
# held, EACH native PR-maintenance worker must report the held lock and exit 0
# (clean no-op), so only one operation ever runs at a time.
#
# Holds the lock the same way the shell lib acquires it (flock if available,
# else the atomic mkdir fallback), then runs each native worker. Fully offline;
# the native lock probe runs before the shell entrypoint, so no `gh` is reached.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-mutex.XXXXXX")"
LOCK="$TMP/crons.lock"
HOLDER_PID=""
cleanup() {
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  rm -rf "${LOCK}.d" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

REAL_NODE="$(command -v node)"
WORKER_SOURCE="$ROOT/packages/execution-engine/src/workers/pr-maintenance-workers.ts"
WORKER_RUNNER_SRC="$TMP/run-native-worker.ts"
WORKER_RUNNER_DIR="$TMP/worker-runner-dist"
WORKER_RUNNER="$WORKER_RUNNER_DIR/run-native-worker.mjs"

write_native_worker_runner() {
  mkdir -p "$WORKER_RUNNER_DIR"
  cat > "$WORKER_RUNNER_SRC" <<TS
import { createCoderabbitAddressWorker, createPrConflictRebaseWorker } from '${WORKER_SOURCE}';

const kind = process.argv[2];
const logger = {
  info: (message: string) => console.log(message),
  warn: (message: string) => console.log(message),
  error: (message: string) => console.log(message),
  debug: () => {},
  child: () => logger,
};
const factories = {
  'coderabbit-address': createCoderabbitAddressWorker,
  'pr-conflict-rebase': createPrConflictRebaseWorker,
};
const factory = factories[kind as keyof typeof factories];
if (!factory) throw new Error(\`unknown PR-maintenance worker kind: \${kind}\`);
const worker = factory({
  logger,
  repoRoot: process.cwd(),
  lockPath: process.env.INVOKER_PR_CRON_LOCK,
  installSignalHandlers: false,
});
try {
  await worker.tick('manual');
} finally {
  await worker.stop();
}
console.log(\`\${kind} worker scan completed.\`);
TS
  pnpm exec tsup "$WORKER_RUNNER_SRC" --format esm --platform node --out-dir "$WORKER_RUNNER_DIR" >/dev/null
}

run_native_worker() {
  "$REAL_NODE" "$WORKER_RUNNER" "$1" 2>&1
}

write_native_worker_runner

# Acquire and hold the lock out-of-band, mirroring cron-pr-lib.sh's mechanism.
if command -v flock >/dev/null 2>&1; then
  READY="$TMP/holder.ready"
  ( exec 9>"$LOCK"; flock 9; : > "$READY"; sleep 60 ) &
  HOLDER_PID=$!
  # Wait until the holder has actually taken the flock (a fixed sleep races and
  # could let a worker slip past cron_lock before the lock is held).
  for _ in $(seq 1 50); do
    [ -f "$READY" ] && break
    sleep 0.1
  done
  [ -f "$READY" ] || fail "lock holder never acquired the flock"
else
  # Mirror the lib's mkdir lock, including the holder PID so the reaper treats it
  # as a live lock (and never reaps it while this repro is running).
  mkdir "${LOCK}.d"
  printf '%s\n' "$$" > "${LOCK}.d/pid"
fi

export INVOKER_PR_CRON_LOCK="$LOCK"
export INVOKER_PR_CRON_DRY_RUN=1
# Point ledgers at temp so even an unexpected pass-through writes nothing real.
export INVOKER_PR_CONFLICT_STATE_FILE="$TMP/conflict.tsv"
export INVOKER_PR_CODERABBIT_STATE_FILE="$TMP/coderabbit.tsv"

for worker in coderabbit-address pr-conflict-rebase; do
  set +e
  out="$(run_native_worker "$worker" 2>&1)"
  code=$?
  set -e
  echo "$out" | grep -q "shared PR maintenance lock held; skipping tick" \
    || fail "$worker did not report the lock as held" "$out"
  [ "$code" -eq 0 ] || fail "$worker exited $code (expected 0 clean no-op)" "$out"
done

echo "[repro] passed"
