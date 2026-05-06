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

async function createBus(transport) {
  const bus = new transport.IpcBus(undefined, { allowServe: false });
  await bus.ready();
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
  return {
    ...item,
    ok: true,
    response,
  };
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
  const bus = await createBus(transport);

  try {
    if (options.mode === 'exec') {
      if (options.args.length === 0) {
        throw new Error('Missing headless args for exec');
      }
      const result = await requestExec(bus, { args: options.args }, options);
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
          const result = await requestExec(bus, item, options);
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
