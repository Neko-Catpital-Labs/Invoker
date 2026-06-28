#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
import { createServer } from 'node:net';

const args = process.argv.slice(2);
const readFlag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

const readyPath = readFlag('--ready');
const stoppedPath = readFlag('--stopped');
const listening = Promise.withResolvers();
const server = createServer();
server.once('error', listening.reject);
server.listen(0, '127.0.0.1', listening.resolve);
await listening.promise;

const shutdown = Promise.withResolvers();
process.once('SIGTERM', () => shutdown.resolve('SIGTERM'));
process.once('SIGINT', () => shutdown.resolve('SIGINT'));

if (readyPath) {
  writeFileSync(readyPath, JSON.stringify({ pid: process.pid, state: 'ready' }), 'utf8');
}

const signal = await shutdown.promise;
if (stoppedPath) {
  writeFileSync(stoppedPath, JSON.stringify({ pid: process.pid, signal, state: 'stopped' }), 'utf8');
}
server.close();
