#!/usr/bin/env node

import { createConnection } from 'node:net';

const [socketPath, ...args] = process.argv.slice(2);
if (!socketPath || args.length === 0) {
  process.stderr.write('usage: headless-exec-once.mjs <socket-path> <headless args...>\n');
  process.exit(2);
}

const requestId = `repro:${process.pid}:${Date.now()}`;
const payload = Buffer.from(JSON.stringify({
  kind: 'req',
  channel: 'headless.exec',
  reqId: requestId,
  body: {
    args,
    traceId: requestId,
  },
}), 'utf8');
const frame = Buffer.allocUnsafe(4 + payload.length);
frame.writeUInt32BE(payload.length, 0);
payload.copy(frame, 4);

const socket = createConnection(socketPath);
let buffered = Buffer.alloc(0);
const timeout = setTimeout(() => {
  process.stderr.write(`timed out waiting for headless.exec response for "${args.join(' ')}"\n`);
  socket.destroy();
  process.exit(124);
}, 30_000);
timeout.unref();

socket.on('connect', () => socket.write(frame));
socket.on('data', (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  while (buffered.length >= 4) {
    const length = buffered.readUInt32BE(0);
    if (buffered.length < 4 + length) return;
    const envelope = JSON.parse(buffered.subarray(4, 4 + length).toString('utf8'));
    buffered = buffered.subarray(4 + length);
    if (envelope.reqId !== requestId) continue;
    clearTimeout(timeout);
    if (envelope.kind === 'res') {
      process.stdout.write(`${JSON.stringify(envelope.body)}\n`);
      socket.end();
      return;
    }
    process.stderr.write(`${envelope.message ?? 'headless.exec failed'}\n`);
    socket.destroy();
    process.exit(1);
  }
});
socket.on('error', (error) => {
  clearTimeout(timeout);
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});
