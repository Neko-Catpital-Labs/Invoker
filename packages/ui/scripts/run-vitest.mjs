import { spawn } from 'node:child_process';

const extraArgs = process.argv.slice(2);
const vitestArgs = extraArgs[0] === '--'
  ? extraArgs.slice(1)
  : extraArgs;

const child = spawn('vitest', ['run', ...vitestArgs], {
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

child.on('error', (error) => {
  console.error(error);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1);
  }
  process.exit(code ?? 1);
});
