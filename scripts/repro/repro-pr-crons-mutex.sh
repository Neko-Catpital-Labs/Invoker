#!/usr/bin/env bash
# Cross-job mutual exclusion proof: while the shared PR-maintenance lock is held,
# each native PR-maintenance worker path must exit 0 as a clean no-op before any
# job body can run.
#
# Holds the lock the same way the native worker probes it, then runs each worker
# through `./run.sh --headless worker <kind>`. The configured shell fails loudly
# if spawned, so success proves the native lock path short-circuited the tick.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

TMP="$(mktemp -d "${TMPDIR:-/tmp}/repro-pr-mutex.XXXXXX")"
LOCK="$TMP/crons.lock"
WORKER_PROOF_TEST="$ROOT/packages/execution-engine/src/__pr_maintenance_repro_$$.test.ts"
HOLDER_PID=""
cleanup() {
  rm -f "$WORKER_PROOF_TEST"
  [ -n "$HOLDER_PID" ] && kill "$HOLDER_PID" 2>/dev/null || true
  rm -rf "${LOCK}.d" 2>/dev/null || true
  rm -rf "$TMP"
}
trap cleanup EXIT

fail() { echo "[repro] FAIL: $1"; [ -n "${2:-}" ] && echo "----- output -----" && echo "$2"; exit 1; }

write_worker_proof_test() {
  cat > "$WORKER_PROOF_TEST" <<'TS'
import { describe, it } from 'vitest';
import { appendFileSync } from 'node:fs';
import { createCoderabbitAddressWorker, createPrConflictRebaseWorker } from './workers/pr-maintenance-workers.js';

const logPath = process.env.REPRO_PR_MAINTENANCE_LOG;
const log = (message: unknown): void => {
  if (logPath) appendFileSync(logPath, `${String(message)}\n`);
};
const logger = { info: log, warn: log, error: log, debug: () => {}, trace: () => {}, child: () => logger };
const rawConfig = JSON.parse(process.env.REPRO_PR_MAINTENANCE_CONFIG ?? '{}');
const prMaintenance = rawConfig.prMaintenance ?? rawConfig;
delete prMaintenance.enabled;

describe('native PR-maintenance repro worker', () => {
  it('runs one tick', async () => {
    const options = { logger, ...prMaintenance };
    const worker = process.env.REPRO_PR_MAINTENANCE_WORKER === 'coderabbit-address'
      ? createCoderabbitAddressWorker(options as never)
      : createPrConflictRebaseWorker(options as never);
    await worker.tick('manual');
    await worker.stop();
  });
});
TS
}

run_native_worker() {
  local worker="$1" config="$2"
  local log="$TMP/native-worker.log"
  local vitest_out code
  write_worker_proof_test
  : > "$log"
  set +e
  vitest_out="$(REPRO_PR_MAINTENANCE_WORKER="$worker" REPRO_PR_MAINTENANCE_CONFIG="$(cat "$config")" REPRO_PR_MAINTENANCE_LOG="$log" pnpm --filter @invoker/execution-engine exec vitest run "src/$(basename "$WORKER_PROOF_TEST")" 2>&1)"
  code=$?
  set -e
  cat "$log"
  printf '%s\n' "$vitest_out"
  return "$code"
}
CONFIG="$TMP/config.json"
mkdir -p "$TMP/home-coderabbit-address" "$TMP/home-pr-conflict-rebase"
cat > "$TMP/fail-if-spawned.sh" <<'SH'
#!/usr/bin/env bash
echo "unexpected PR maintenance spawn: $*" >&2
exit 42
SH
chmod +x "$TMP/fail-if-spawned.sh"

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

cat > "$CONFIG" <<EOF
{"prMaintenance":{"enabled":true,"repoRoot":"$ROOT","lockPath":"$LOCK","shell":"$TMP/fail-if-spawned.sh","env":{"INVOKER_PR_CRON_DRY_RUN":"1","INVOKER_PR_CONFLICT_STATE_FILE":"$TMP/conflict.tsv","INVOKER_PR_CODERABBIT_STATE_FILE":"$TMP/coderabbit.tsv","INVOKER_PR_CRON_LOCK":"$LOCK"}}}
EOF

for worker in coderabbit-address pr-conflict-rebase; do
  set +e
  out="$(run_native_worker "$worker" "$CONFIG")"
  code=$?
  set -e
  [ "$code" -eq 0 ] || fail "$worker exited $code (expected 0 clean no-op)" "$out"
  echo "$out" | grep -q "shared PR maintenance lock held; skipping tick" \
    || fail "$worker did not report the held native PR-maintenance lock" "$out"
  ! echo "$out" | grep -q "unexpected PR maintenance spawn" \
    || fail "$worker spawned the job body despite the held lock" "$out"
done

echo "[repro] passed"
