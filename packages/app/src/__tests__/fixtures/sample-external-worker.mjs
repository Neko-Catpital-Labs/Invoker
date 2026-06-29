import { writeFileSync } from 'node:fs';

const markerPath = process.argv[2];
if (!markerPath) {
  process.stderr.write('usage: sample-external-worker.mjs <marker-path>\n');
  process.exit(64);
}

writeFileSync(markerPath, JSON.stringify({ pid: process.pid, started: true }), 'utf8');

const keepAlive = setInterval(() => {}, 1_000);

const shutdown = () => {
  clearInterval(keepAlive);
  process.exit(0);
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
