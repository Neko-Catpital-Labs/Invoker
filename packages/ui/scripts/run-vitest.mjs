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
  console.error(result.error);
  process.exit(1);
}

process.exit(result.status ?? (result.signal ? 1 : 0));
