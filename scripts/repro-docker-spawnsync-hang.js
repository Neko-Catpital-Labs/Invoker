#!/usr/bin/env node
/**
 * Repro: does `spawnSync('docker', ['--version'])` actually hang on this
 * machine?
 *
 * Mirrors what `packages/app/src/system-diagnostics.ts` does, with extra
 * timing so we can see if/where it blocks. Exits with code 0 if docker
 * responds in under 5s; exits with code 2 if it hangs past 5s.
 */
const { spawnSync } = require('node:child_process');

const command = process.argv[2] || 'docker';
const args = process.argv.slice(3);
if (args.length === 0) args.push('--version');

console.log(`[repro] PID=${process.pid} spawning: ${command} ${args.join(' ')} (no timeout)`);
const started = Date.now();

// Watchdog: independent timer prints elapsed every second so we can see
// the spawnSync is actually blocking the event loop.
const watchdog = setInterval(() => {
  process.stderr.write(`[repro] still spawning after ${Date.now() - started}ms\n`);
  if (Date.now() - started > 5000) {
    process.stderr.write('[repro] >5s elapsed — assuming HANG, exiting 2\n');
    // We have to exit hard because the main thread is in spawnSync;
    // setInterval can't actually fire while spawnSync blocks the event loop.
    process.exit(2);
  }
}, 1000);
watchdog.unref?.();

const result = spawnSync(command, args, { encoding: 'utf8' });
const elapsed = Date.now() - started;
clearInterval(watchdog);

if (result.error) {
  console.error(`[repro] error after ${elapsed}ms:`, result.error);
  process.exit(3);
}
console.log(`[repro] returned in ${elapsed}ms status=${result.status} signal=${result.signal}`);
console.log(`[repro] stdout: ${(result.stdout || '').trim()}`);
console.log(`[repro] stderr: ${(result.stderr || '').trim()}`);
process.exit(0);
