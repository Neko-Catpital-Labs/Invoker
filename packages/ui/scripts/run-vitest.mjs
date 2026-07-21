import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const forwardedArgs = process.argv.slice(2);
const vitestArgs = forwardedArgs[0] === '--' ? forwardedArgs.slice(1) : forwardedArgs;

function executable(name) {
  return process.platform === 'win32' ? `${name}.cmd` : name;
}

function findWorkspaceRoot(startDir) {
  let current = resolve(startDir);
  while (true) {
    if (
      existsSync(resolve(current, 'pnpm-workspace.yaml'))
      || existsSync(resolve(current, 'pnpm-lock.yaml'))
    ) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) return resolve(startDir);
    current = parent;
  }
}

function run(command, args, options = {}) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      ...options,
    });

    child.on('error', rejectRun);
    child.on('exit', (code, signal) => {
      resolveRun({ code, signal });
    });
  });
}

function exitWith({ code, signal }) {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 1);
}

async function provisionDependencies() {
  const root = findWorkspaceRoot(process.cwd());
  console.error(`[run-vitest] vitest not found; running pnpm install --frozen-lockfile in ${root}`);

  const result = await run(executable('pnpm'), ['install', '--frozen-lockfile'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'development' },
  });

  if (result.signal) {
    throw new Error(`pnpm install terminated by ${result.signal}`);
  }

  if (result.code !== 0) {
    throw new Error(`pnpm install --frozen-lockfile failed with exit code ${result.code ?? 1}`);
  }
}

async function runVitest({ allowProvision }) {
  try {
    const result = await run(executable('vitest'), ['run', ...vitestArgs]);
    exitWith(result);
  } catch (error) {
    if (
      allowProvision
      && (error?.code === 'ENOENT' || error?.errno === -2)
    ) {
      await provisionDependencies();
      await runVitest({ allowProvision: false });
      return;
    }

    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}

runVitest({ allowProvision: true }).catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
