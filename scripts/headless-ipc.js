#!/usr/bin/env node
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const { IpcBus } = require(path.join(repoRoot, 'packages', 'transport', 'dist'));

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error) => {
    if (error && error.code === 'EPIPE') {
      process.exit(0);
    }
    throw error;
  });
}

function usage() {
  console.error(
    'Usage:\n' +
    '  node scripts/headless-ipc.js exec [--no-track] [--wait-for-approval] [--timeout-ms N] -- <headless args...>\n' +
    '  node scripts/headless-ipc.js batch-exec [--no-track] [--wait-for-approval] [--timeout-ms N] [--parallel N] < commands.jsonl',
  );
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
    }),
  ]);
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

async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

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

async function main() {
  const options = parseCli(process.argv.slice(2));
  const bus = new IpcBus(undefined, { allowServe: false });
  await bus.ready();

  try {
    if (options.mode === 'exec') {
      if (options.args.length === 0) {
        throw new Error('Missing headless args for exec');
      }
      const result = await requestExec(bus, { args: options.args }, options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return;
    }

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
