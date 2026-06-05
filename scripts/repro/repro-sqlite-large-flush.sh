#!/usr/bin/env bash
# Repro: sql.js-backed SQLite flush exports the full database after a small write.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/repro/repro-sqlite-large-flush.sh [--expect-issue]

Seeds a temporary SQLite database with controlled task/output data, performs one
small task update, forces the adapter flush, and prints the adapter-reported
exported byte size and elapsed flush duration.

Default pass threshold after the optimization:
  exportedBytes < 268435456  (256 MiB)
  flushElapsedMs < 250

Before the optimization, run with --expect-issue. That mode exits 0 when either
threshold is exceeded, documenting the current full-database export behavior.

Optional environment overrides:
  REPRO_SQLITE_FLUSH_SEED_MB       default 320
  REPRO_SQLITE_FLUSH_CHUNK_KIB     default 1024
  REPRO_SQLITE_FLUSH_MAX_BYTES     default 268435456
  REPRO_SQLITE_FLUSH_MAX_MS        default 250
USAGE
}

EXPECT_ISSUE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --expect-issue)
      EXPECT_ISSUE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "error: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DATA_STORE_DIR="$REPO_ROOT/packages/data-store"

SEED_MB="${REPRO_SQLITE_FLUSH_SEED_MB:-320}"
CHUNK_KIB="${REPRO_SQLITE_FLUSH_CHUNK_KIB:-1024}"
MAX_BYTES="${REPRO_SQLITE_FLUSH_MAX_BYTES:-268435456}"
MAX_MS="${REPRO_SQLITE_FLUSH_MAX_MS:-250}"

ESBUILD_BIN="$(
  find "$REPO_ROOT/node_modules/.pnpm" -path '*/node_modules/esbuild/bin/esbuild' -type f 2>/dev/null \
    | LC_ALL=C sort \
    | tail -n 1
)"

if [[ -z "$ESBUILD_BIN" ]]; then
  echo "error: esbuild binary not found under node_modules/.pnpm; run pnpm install first" >&2
  exit 1
fi

HELPER_DIR="$(mktemp -d "$DATA_STORE_DIR/.tmp-repro-sqlite-large-flush.XXXXXX")"
DB_DIR="$(mktemp -d "${TMPDIR:-/tmp}/invoker-sqlite-large-flush.XXXXXX")"
cleanup() {
  rm -rf "$HELPER_DIR" "$DB_DIR"
}
trap cleanup EXIT

HELPER_TS="$HELPER_DIR/helper.ts"
HELPER_JS="$HELPER_DIR/out/helper.cjs"
DB_PATH="$DB_DIR/invoker.db"
SQL_WASM="$DATA_STORE_DIR/node_modules/sql.js/dist/sql-wasm.wasm"

if [[ ! -f "$SQL_WASM" ]]; then
  echo "error: sql.js WASM not found at $SQL_WASM; run pnpm install first" >&2
  exit 1
fi

cat > "$HELPER_TS" <<'TS'
import { statSync } from 'node:fs';
import { SQLiteAdapter } from '../src/sqlite-adapter.ts';
import { createTaskState } from '@invoker/workflow-core';

async function main(): Promise<void> {
  const [
    dbPath,
    seedMbRaw,
    chunkKibRaw,
    maxBytesRaw,
    maxMsRaw,
    expectIssueRaw,
  ] = process.argv.slice(2);

  if (!dbPath || !seedMbRaw || !chunkKibRaw || !maxBytesRaw || !maxMsRaw || !expectIssueRaw) {
    throw new Error('missing helper arguments');
  }

  const seedMb = Number(seedMbRaw);
  const chunkKib = Number(chunkKibRaw);
  const maxBytes = Number(maxBytesRaw);
  const maxMs = Number(maxMsRaw);
  const expectIssue = expectIssueRaw === '1';

  for (const [name, value] of Object.entries({ seedMb, chunkKib, maxBytes, maxMs })) {
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${name} must be a positive number`);
    }
  }

  process.env.INVOKER_SQLITE_FLUSH_DEBOUNCE_MS = '60000';
  process.env.INVOKER_SQLITE_FLUSH_WARN_THRESHOLD_MS = '0';
  process.env.INVOKER_SQLITE_FLUSH_WARN_DB_MB = '0';
  process.env.INVOKER_SQLITE_FLUSH_WARN_COOLDOWN_MS = '0';

  type FlushMetric = {
    elapsedMs: number;
    sizeBytes: number;
    debounceMs: number;
  };

  const flushMetrics: FlushMetric[] = [];
  let measuring = false;
  const originalStderrWrite = process.stderr.write.bind(process.stderr);

  process.stderr.write = ((chunk: string | Uint8Array, ...args: unknown[]) => {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    const match = text.match(/\[sqlite-flush\] slow-or-large flush elapsedMs=(\d+) sizeBytes=(\d+) debounceMs=(\d+)/);
    if (match && measuring) {
      flushMetrics.push({
        elapsedMs: Number(match[1]),
        sizeBytes: Number(match[2]),
        debounceMs: Number(match[3]),
      });
    }
    if (match) {
      return true;
    }
    return originalStderrWrite(chunk as never, ...(args as never[]));
  }) as typeof process.stderr.write;

  const workflowId = 'wf-sqlite-large-flush-repro';
  const taskId = `${workflowId}/large-output`;
  const createdAt = new Date('2026-06-05T00:00:00.000Z');
  const now = createdAt.toISOString();
  const chunk = 'x'.repeat(chunkKib * 1024);
  const chunkCount = Math.ceil((seedMb * 1024) / chunkKib);

  const seedAdapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  seedAdapter.runInTransaction(() => {
    seedAdapter.saveWorkflow({
      id: workflowId,
      name: 'SQLite large flush repro',
      description: 'Controlled database used to reproduce full export flush cost',
      status: 'running',
      createdAt: now,
      updatedAt: now,
      mergeMode: 'manual',
    });

    const task = createTaskState(taskId, 'Task with deterministic large output', [], {
      workflowId,
      command: 'printf controlled-output',
      runnerKind: 'local',
    });
    seedAdapter.saveTask(workflowId, { ...task, createdAt });

    for (let i = 0; i < chunkCount; i += 1) {
      seedAdapter.appendTaskOutput(taskId, chunk);
    }
  });
  seedAdapter.close();

  const adapter = await SQLiteAdapter.create(dbPath, { ownerCapability: true });
  measuring = true;
  adapter.updateTask(taskId, {
    status: 'running',
    execution: {
      startedAt: new Date('2026-06-05T00:00:01.000Z'),
      lastHeartbeatAt: new Date('2026-06-05T00:00:02.000Z'),
    },
  });
  adapter.close();
  measuring = false;

  const metric = flushMetrics.at(-1);
  if (!metric) {
    throw new Error('adapter did not report a flush metric for the measured write');
  }

  const fileBytes = statSync(dbPath).size;
  const exceededBytes = metric.sizeBytes >= maxBytes;
  const exceededMs = metric.elapsedMs >= maxMs;
  const issueExceeded = exceededBytes || exceededMs;
  const optimized = !exceededBytes && !exceededMs;

  console.log(`dbPath=${dbPath}`);
  console.log(`seedMb=${seedMb}`);
  console.log(`chunkKib=${chunkKib}`);
  console.log(`chunkCount=${chunkCount}`);
  console.log(`fileBytes=${fileBytes}`);
  console.log(`exportedBytes=${metric.sizeBytes}`);
  console.log(`flushElapsedMs=${metric.elapsedMs}`);
  console.log(`flushDebounceMs=${metric.debounceMs}`);
  console.log(`maxExportedBytes=${maxBytes}`);
  console.log(`maxFlushElapsedMs=${maxMs}`);
  console.log(`exceededExportedBytes=${exceededBytes ? 1 : 0}`);
  console.log(`exceededFlushElapsedMs=${exceededMs ? 1 : 0}`);

  if (expectIssue) {
    if (issueExceeded) {
      console.log('result=PASS expected issue reproduced');
      process.exit(0);
    }
    console.error('result=FAIL --expect-issue was set, but neither documented threshold was exceeded');
    process.exit(1);
  }

  if (optimized) {
    console.log('result=PASS flush is under documented thresholds');
    process.exit(0);
  }

  console.error('result=FAIL flush exceeded documented threshold; use --expect-issue before the optimization');
  process.exit(1);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
TS

"$ESBUILD_BIN" "$HELPER_TS" \
  --bundle \
  --platform=node \
  --format=cjs \
  --log-level=error \
  --outfile="$HELPER_JS"

cp "$SQL_WASM" "$HELPER_DIR/out/sql-wasm.wasm"

node "$HELPER_JS" "$DB_PATH" "$SEED_MB" "$CHUNK_KIB" "$MAX_BYTES" "$MAX_MS" "$EXPECT_ISSUE"
