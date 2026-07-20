#!/usr/bin/env node
/**
 * Thin CLI wrapper around the shared IPC transport.
 *
 * Keeps CLI parsing and JSON / JSONL output.
 * Transport policy lives in @invoker/transport (IpcBus) — this script
 * only creates a client-only bus and delegates exec requests through it.
 *
 * Standalone mode: when no IPC server is reachable the script falls back
 * to spawning the headless-client process directly, so a shared socket is
 * not required.
 */
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const TRANSPORT_DIST = path.join(REPO_ROOT, 'packages', 'transport', 'dist', 'index.js');
const HEADLESS_CLIENT_DIST = path.join(REPO_ROOT, 'packages', 'app', 'dist', 'headless-client.js');

// ---------------------------------------------------------------------------
// EPIPE handling — keep output clean when piped to head / grep / etc.
// ---------------------------------------------------------------------------

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

// ---------------------------------------------------------------------------
// CLI parsing (unchanged contract)
// ---------------------------------------------------------------------------

function usage() {
  console.error(
    'Usage:\n' +
    '  node scripts/headless-ipc.js exec [--no-track] [--wait-for-approval] [--timeout-ms N] -- <headless args...>\n' +
    '  node scripts/headless-ipc.js batch-exec [--no-track] [--wait-for-approval] [--timeout-ms N] [--parallel N] < commands.jsonl',
  );
}

function parseCli(argv) {
  const mode = argv[0];
  if (mode !== 'exec' && mode !== 'batch-exec') {
    usage();
    process.exit(2);
  }

  let noTrack = false;
  let waitForApproval = false;
  let parallel = 1;
  let timeoutMs = 30_000;
  const args = [];
  let afterDoubleDash = false;

  for (let i = 1; i < argv.length; i += 1) {
    const token = argv[i];
    if (afterDoubleDash) {
      args.push(token);
      continue;
    }
    if (token === '--') {
      afterDoubleDash = true;
      continue;
    }
    if (token === '--no-track') {
      noTrack = true;
      continue;
    }
    if (token === '--wait-for-approval') {
      waitForApproval = true;
      continue;
    }
    if (token === '--parallel') {
      parallel = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
      continue;
    }
    if (token === '--timeout-ms') {
      timeoutMs = Number.parseInt(argv[i + 1] ?? '', 10);
      i += 1;
      continue;
    }
    args.push(token);
  }

  return { mode, noTrack, waitForApproval, parallel, timeoutMs, args };
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timer));
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableDispatchError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /database is locked|SQLITE_BUSY|Timed out after/i.test(message);
}

function isNoHandlerError(error) {
  if (error && typeof error === 'object' && error.code === 'NO_HANDLER') {
    return true;
  }
  const message = error instanceof Error ? error.message : String(error);
  return /NO_HANDLER|No request handler registered|No handler registered/i.test(message);
}

// ---------------------------------------------------------------------------
// Stdin reader (for batch-exec)
// ---------------------------------------------------------------------------

async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Transport — load IpcBus from the shared transport dist
// ---------------------------------------------------------------------------

async function loadTransport() {
  if (!existsSync(TRANSPORT_DIST)) {
    return null;
  }
  const mod = await import(TRANSPORT_DIST);
  return mod;
}

async function createBus(transport, timeoutMs) {
  const bus = new transport.IpcBus(undefined, { allowServe: false });
  try {
    await withTimeout(bus.ready(), timeoutMs);
  } catch (error) {
    bus.disconnect();
    throw error;
  }
  return bus;
}

// ---------------------------------------------------------------------------
// Standalone fallback — spawn headless-client directly (no socket needed)
// ---------------------------------------------------------------------------

function execStandalone(args) {
  if (!existsSync(HEADLESS_CLIENT_DIST)) {
    throw new Error(
      `Standalone mode requires a built headless-client at ${HEADLESS_CLIENT_DIST}.\n` +
      'Run: pnpm --filter @invoker/app build',
    );
  }
  try {
    execFileSync(process.execPath, [HEADLESS_CLIENT_DIST, ...args], {
      stdio: ['inherit', 'inherit', 'inherit'],
    });
    return 0;
  } catch (err) {
    return err.status ?? 1;
  }
}

// ---------------------------------------------------------------------------
// Request execution via the shared bus
// ---------------------------------------------------------------------------

async function requestExec(bus, item, options) {
  const payload = {
    args: item.args,
    noTrack: options.noTrack,
    waitForApproval: options.waitForApproval,
  };
  const response = await withTimeout(bus.request('headless.exec', payload), options.timeoutMs);
  if (options.noTrack) {
    const acknowledged =
      response &&
      typeof response === 'object' &&
      response.ok === true &&
      (typeof response.intentId === 'number' || typeof response.intentId === 'string');
    if (!acknowledged) {
      throw new Error(
        `Fire-and-forget dispatch was not queued for args "${item.args.join(' ')}"; ` +
        `expected owner response { ok: true, intentId }, got ${JSON.stringify(response)}`,
      );
    }
  }
  return {
    ...item,
    ok: true,
    response,
  };
}

async function requestExecWithRetry(bus, item, options) {
  const maxAttempts = Number.parseInt(process.env.INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS ?? '8', 10);
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 8;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestExec(bus, item, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableDispatchError(error)) {
        throw error;
      }
      const delayMs = Math.min(5_000, 250 * attempt * attempt);
      process.stderr.write(
        `headless.exec dispatch attempt ${attempt}/${attempts} failed for "${item.args.join(' ')}"; ` +
        `retrying in ${delayMs}ms: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      await sleep(delayMs);
    }
  }
  throw lastError;
}

async function requestBatchExec(bus, items, options) {
  const payload = {
    items,
    noTrack: options.noTrack,
    waitForApproval: options.waitForApproval,
  };
  const response = await withTimeout(bus.request('headless.batch-exec', payload), options.timeoutMs);
  if (!Array.isArray(response)) {
    throw new Error(`headless.batch-exec returned non-array response: ${JSON.stringify(response)}`);
  }
  return response;
}

async function requestBatchExecWithRetry(bus, items, options) {
  const maxAttempts = Number.parseInt(process.env.INVOKER_HEADLESS_IPC_DISPATCH_ATTEMPTS ?? '8', 10);
  const attempts = Number.isFinite(maxAttempts) && maxAttempts > 0 ? maxAttempts : 8;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestBatchExec(bus, items, options);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || isNoHandlerError(error) || !isRetryableDispatchError(error)) {
        throw error;
      }
      const delayMs = Math.min(5_000, 250 * attempt * attempt);
      await sleep(delayMs);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const options = parseCli(process.argv.slice(2));

  // Try to load the shared transport module.
  const transport = await loadTransport();
  if (!transport) {
    // No built transport — fall back to standalone mode for exec.
    if (options.mode === 'exec') {
      const cliArgs = [];
      if (options.noTrack) cliArgs.push('--no-track');
      if (options.waitForApproval) cliArgs.push('--wait-for-approval');
      cliArgs.push(...options.args);
      process.exitCode = execStandalone(cliArgs);
      return;
    }
    throw new Error(
      'batch-exec requires the shared transport module.\n' +
      'Build the transport package: cd packages/transport && pnpm build',
    );
  }

  // Create a client-only IPC bus (no server election).
  const bus = await createBus(transport, options.timeoutMs);

  try {
    if (options.mode === 'exec') {
      if (options.args.length === 0) {
        throw new Error('Missing headless args for exec');
      }
      const result = await requestExecWithRetry(bus, { args: options.args }, options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

    // batch-exec
    const lines = await readStdinLines();
    const items = lines.map((line) => {
      const parsed = JSON.parse(line);
      if (Array.isArray(parsed)) {
        return { args: parsed };
      }
      if (!parsed || !Array.isArray(parsed.args)) {
        throw new Error(`Invalid batch item: ${line}`);
      }
      return parsed;
    });

    if (options.noTrack) {
      try {
        const results = await requestBatchExecWithRetry(bus, items, options);
        for (const result of results) {
          process.stdout.write(`${JSON.stringify(result)}\n`);
        }
        return;
      } catch (error) {
        if (!isNoHandlerError(error)) {
          throw error;
        }
        process.stderr.write('headless.batch-exec handler unavailable; falling back to per-item headless.exec dispatch\n');
      }
    }

    let nextIndex = 0;
    const parallel = Math.max(1, Number.isFinite(options.parallel) ? options.parallel : 1);

    async function worker() {
      while (true) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) {
          return;
        }
        const item = items[index];
        try {
          const result = await requestExecWithRetry(bus, item, options);
          process.stdout.write(`${JSON.stringify(result)}\n`);
        } catch (error) {
          process.stdout.write(`${JSON.stringify({
            ...item,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })}\n`);
        }
      }
    }

    await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, () => worker()));
  } finally {
    bus.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
