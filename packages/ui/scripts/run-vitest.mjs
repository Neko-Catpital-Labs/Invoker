import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
if (args[0] === '--') {
  args.shift();
}

const result = spawnSync('vitest', ['run', ...args], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (result.error) {
  throw result.error;
}

if (result.signal) {
  process.kill(process.pid, result.signal);
} else {
  process.exit(result.status ?? 1);
}
