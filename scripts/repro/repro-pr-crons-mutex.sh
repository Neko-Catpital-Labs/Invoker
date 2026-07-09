#!/usr/bin/env bash
# Cross-job mutual exclusion proof: while the shared lock is held, EACH native
# PR maintenance worker tick must report "shared PR maintenance lock held;
# skipping tick" and exit 0 (clean no-op), so only one operation ever runs at a
# time.
#
# Holds the lock the same way the shell lib acquires it (flock if available,
# else the atomic mkdir fallback), then runs each native worker. Fully offline;
# the native worker probes the lock before spawning a shell entrypoint, so no
# `gh` is reached.
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

WORKER_RUNNER="$TMP/run-pr-maintenance-worker.mjs"
WORKER_LOADER="$TMP/ts-js-loader.mjs"

cat > "$WORKER_LOADER" <<'NODE'
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (specifier.endsWith('.js')) {
      return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    }
    throw err;
  }
}
NODE

cat > "$WORKER_RUNNER" <<'NODE'
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [kind, configPath, repoRoot] = process.argv.slice(2);
const engine = await import(pathToFileURL(
  `${repoRoot}/packages/execution-engine/src/workers/pr-maintenance-workers.ts`,
).href);
const config = JSON.parse(readFileSync(configPath, 'utf8')).prMaintenance;
const logger = {
  info(message) { console.log(message); },
  warn(message) { console.error(message); },
  error(message) { console.error(message); },
  debug() {},
  child() { return this; },
};
const worker = kind === 'coderabbit-address'
  ? engine.createCoderabbitAddressWorker({ logger, ...config, installSignalHandlers: false })
  : engine.createPrConflictRebaseWorker({ logger, ...config, installSignalHandlers: false });
try {
  await worker.tick('manual');
  await worker.stop();
  console.log(`${kind} worker scan completed.`);
} catch (err) {
  await worker.stop();
  console.error(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
}
NODE

write_config() {
  local worker="$1" ledger="$2" config="$3"
  local state_key
  if [ "$worker" = "coderabbit-address" ]; then
    state_key="INVOKER_PR_CODERABBIT_STATE_FILE"
  else
    state_key="INVOKER_PR_CONFLICT_STATE_FILE"
  fi
  jq -n \
    --arg repoRoot "$ROOT" \
    --arg lock "$LOCK" \
    --arg ledger "$ledger" \
    --arg stateKey "$state_key" \
    '{
      enabled: true,
      repoRoot: $repoRoot,
      lockPath: $lock,
      env: {
        INVOKER_PR_CRON_DRY_RUN: "1",
        ($stateKey): $ledger
      }
    } | { prMaintenance: . }' > "$config"
}

run_worker() {
  NODE_NO_WARNINGS=1 node --loader "$WORKER_LOADER" "$WORKER_RUNNER" "$1" "$2" "$ROOT" 2>&1
}

for worker in coderabbit-address pr-conflict-rebase; do
  config="$TMP/$worker-config.json"
  if [ "$worker" = "coderabbit-address" ]; then
    ledger="$TMP/coderabbit.tsv"
  else
    ledger="$TMP/conflict.tsv"
  fi
  write_config "$worker" "$ledger" "$config"
  set +e
  out="$(run_worker "$worker" "$config")"
  code=$?
  set -e
  echo "$out" | grep -q "shared PR maintenance lock held; skipping tick" \
    || fail "$worker did not report the native lock probe as held" "$out"
  echo "$out" | grep -q "$worker worker scan completed" \
    || fail "$worker did not complete the native worker tick" "$out"
done

echo "[repro] passed"
