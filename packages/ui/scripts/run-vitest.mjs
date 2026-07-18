import { spawn } from 'node:child_process';

const forwardedArgs = process.argv.slice(2);

if (forwardedArgs[0] === '--') {
  forwardedArgs.shift();
}

const command = process.platform === 'win32' ? 'vitest.cmd' : 'vitest';
const child = spawn(command, ['run', ...forwardedArgs], {
  stdio: 'inherit',
});

child.on('error', (error) => {
  console.error(error.message);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
});
