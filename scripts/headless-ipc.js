#!/usr/bin/env node
const { createConnection } = require('node:net');
const { homedir } = require('node:os');
const path = require('node:path');

const DEFAULT_SOCKET_PATH =
  process.env.INVOKER_IPC_SOCKET || path.join(homedir(), '.invoker', 'ipc-transport.sock');

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

function encodeEnvelope(envelope) {
  const json = Buffer.from(JSON.stringify(envelope), 'utf8');
  const frame = Buffer.allocUnsafe(4 + json.length);
  frame.writeUInt32BE(json.length, 0);
  json.copy(frame, 4);
  return frame;
}

class FrameDecoder {
  constructor(onEnvelope) {
    this.buf = Buffer.alloc(0);
    this.onEnvelope = onEnvelope;
  }

  push(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 4) {
      const len = this.buf.readUInt32BE(0);
      if (this.buf.length < 4 + len) {
        break;
      }
      const json = this.buf.subarray(4, 4 + len).toString('utf8');
      this.buf = this.buf.subarray(4 + len);
      this.onEnvelope(JSON.parse(json));
    }
  }
}

class HeadlessIpcClient {
  constructor(socketPath = DEFAULT_SOCKET_PATH) {
    this.socketPath = socketPath;
    this.nextReqId = 0;
    this.pending = new Map();
    this.socket = null;
    this.decoder = new FrameDecoder((envelope) => this.handleEnvelope(envelope));
  }

  async connect() {
    if (this.socket) {
      return;
    }
    this.socket = await new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      const cleanup = () => {
        socket.off('connect', handleConnect);
        socket.off('error', handleError);
      };
      const handleConnect = () => {
        cleanup();
        resolve(socket);
      };
      const handleError = (error) => {
        cleanup();
        reject(error);
      };
      socket.once('connect', handleConnect);
      socket.once('error', handleError);
    });

    this.socket.on('data', (chunk) => this.decoder.push(chunk));
    this.socket.on('error', (error) => {
      this.rejectAll(error);
    });
    this.socket.on('close', () => {
      this.rejectAll(new Error('IPC socket closed'));
      this.socket = null;
    });
  }

  handleEnvelope(envelope) {
    if (envelope.kind !== 'res' && envelope.kind !== 'err') {
      return;
    }
    const pending = this.pending.get(envelope.reqId);
    if (!pending) {
      return;
    }
    this.pending.delete(envelope.reqId);
    if (envelope.kind === 'err') {
      pending.reject(new Error(envelope.message));
      return;
    }
    pending.resolve(envelope.body);
  }

  rejectAll(error) {
    for (const { reject } of this.pending.values()) {
      reject(error);
    }
    this.pending.clear();
  }

  async request(channel, body) {
    await this.connect();
    const reqId = `req-${this.nextReqId += 1}`;
    const response = new Promise((resolve, reject) => {
      this.pending.set(reqId, { resolve, reject });
    });
    this.socket.write(encodeEnvelope({
      kind: 'req',
      channel,
      body,
      reqId,
    }));
    return response;
  }

  disconnect() {
    if (!this.socket) {
      return;
    }
    this.socket.destroy();
    this.socket = null;
  }
}

async function readStdinLines() {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8').split('\n').map((line) => line.trim()).filter(Boolean);
}

async function requestExec(client, item, options) {
  const payload = {
    args: item.args,
    noTrack: options.noTrack,
    waitForApproval: options.waitForApproval,
  };
  const response = await withTimeout(client.request('headless.exec', payload), options.timeoutMs);
  return {
    ...item,
    ok: true,
    response,
  };
}

async function main() {
  const options = parseCli(process.argv.slice(2));
  const client = new HeadlessIpcClient();

  try {
    if (options.mode === 'exec') {
      if (options.args.length === 0) {
        throw new Error('Missing headless args for exec');
      }
      const result = await requestExec(client, { args: options.args }, options);
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
          const result = await requestExec(client, item, options);
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
    client.disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
