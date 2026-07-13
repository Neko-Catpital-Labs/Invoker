import { writeFileSync } from 'node:fs';

const markerPath = process.argv[2];
if (!markerPath) {
  process.stderr.write('usage: sample-external-worker.mjs <marker-path>\n');
  process.exit(64);
}

const writeMarker = (state) => {
  writeFileSync(markerPath, JSON.stringify({ pid: process.pid, ...state }), 'utf8');
};

writeMarker({ started: true, stopped: false });

const keepAlive = setInterval(() => {}, 1_000);

const shutdown = () => {
  clearInterval(keepAlive);
  writeMarker({ started: true, stopped: true });
  process.exit(0);
};

process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
