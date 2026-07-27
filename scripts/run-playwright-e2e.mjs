#!/usr/bin/env node
import { execFile as execFileCb, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import process from 'node:process';
import { randomInt } from 'node:crypto';
import { once } from 'node:events';
import { promisify } from 'node:util';

const execFile = promisify(execFileCb);
const X_DISPLAY_BASE = 200;
const X_DISPLAY_SPAN = 10_000;
let activePlaywright;
let activeXvfb;
let shuttingDown = false;

async function commandExists(command) {
  try {
    await execFile('sh', ['-c', 'command -v "$1"', 'sh', command]);
    return true;
  } catch {
    return false;
  }
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function canOpenXDisplay(env) {
  if (process.platform !== 'linux' || !env.DISPLAY) return process.platform !== 'linux';
  if (!await commandExists('xdpyinfo')) return true;
  try {
    await execFile('xdpyinfo', [], { env, timeout: 2_000 });
    return true;
  } catch {
    return false;
  }
}

function hasDisplayArtifacts(displayNumber) {
  return existsSync(`/tmp/.X${displayNumber}-lock`) || existsSync(`/tmp/.X11-unix/X${displayNumber}`);
}

function chooseDisplayNumber() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const displayNumber = X_DISPLAY_BASE + randomInt(X_DISPLAY_SPAN);
    if (!hasDisplayArtifacts(displayNumber)) return displayNumber;
  }
  for (let displayNumber = X_DISPLAY_BASE; displayNumber < X_DISPLAY_BASE + X_DISPLAY_SPAN; displayNumber += 1) {
    if (!hasDisplayArtifacts(displayNumber)) return displayNumber;
  }
  throw new Error('Unable to find a free Xvfb display number');
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await Promise.race([
    once(child, 'exit').catch(() => undefined),
    sleep(1_000),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await Promise.race([
      once(child, 'exit').catch(() => undefined),
      sleep(1_000),
    ]);
  }
}

async function startXvfb() {
  if (!await commandExists('Xvfb')) return undefined;

  let lastError;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const displayNumber = chooseDisplayNumber();
    const display = `:${displayNumber}`;
    const child = spawn('Xvfb', [
      display,
      '-screen', '0', '1280x1024x24',
      '-nolisten', 'tcp',
    ], {
      stdio: 'ignore',
      detached: false,
    });
    child.once('error', (error) => {
      lastError = error;
    });

    const env = { ...process.env, DISPLAY: display };
    delete env.XAUTHORITY;
    for (let waitAttempt = 0; waitAttempt < 50; waitAttempt += 1) {
      if (child.exitCode !== null || child.signalCode !== null) break;
      if (await canOpenXDisplay(env)) {
        return { child, display };
      }
      await sleep(100);
    }

    await stopChild(child);
  }

  throw new Error(`Unable to start Xvfb${lastError instanceof Error ? `: ${lastError.message}` : ''}`);
}

function exitCodeForSignal(signal) {
  if (!signal) return 1;
  const signals = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGILL: 4,
    SIGTRAP: 5,
    SIGABRT: 6,
    SIGBUS: 7,
    SIGFPE: 8,
    SIGKILL: 9,
    SIGUSR1: 10,
    SIGSEGV: 11,
    SIGUSR2: 12,
    SIGPIPE: 13,
    SIGALRM: 14,
    SIGTERM: 15,
  };
  return 128 + (signals[signal] ?? 1);
}

async function runPlaywright(args, env) {
  const command = process.platform === 'win32' ? 'playwright.cmd' : 'playwright';
  const child = spawn(command, ['test', ...args], {
    stdio: 'inherit',
    env,
    shell: process.platform === 'win32',
  });
  activePlaywright = child;
  try {
    const [code, signal] = await once(child, 'exit');
    return typeof code === 'number' ? code : exitCodeForSignal(signal);
  } finally {
    activePlaywright = undefined;
  }
}

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (activePlaywright && activePlaywright.exitCode === null && activePlaywright.signalCode === null) {
    activePlaywright.kill(signal);
  }
  await stopChild(activeXvfb?.child);
  process.exit(exitCodeForSignal(signal));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--') args.shift();

  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      void shutdown(signal);
    });
  }

  const env = { ...process.env };
  let xvfb;
  if (process.platform === 'linux' && !await canOpenXDisplay(env)) {
    xvfb = await startXvfb();
    if (xvfb) {
      activeXvfb = xvfb;
      env.DISPLAY = xvfb.display;
      delete env.XAUTHORITY;
    }
  }

  let exitCode = 1;
  try {
    exitCode = await runPlaywright(args, env);
  } finally {
    await stopChild(xvfb?.child);
    activeXvfb = undefined;
  }
  process.exitCode = exitCode;
}

main().catch((error) => {
  console.error(`run-playwright-e2e: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exitCode = 1;
});
