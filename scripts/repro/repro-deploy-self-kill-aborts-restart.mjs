#!/usr/bin/env node
// Safe, local, no-network repro of the deploy-do1.sh self-kill bug, built
// with the exact same primitives Invoker's own code uses (node:child_process
// spawn with detached:true, and process.kill(-pid, signal) for the group
// kill), so it isn't subject to bash job-control quirks.
//
// Mechanism under test: deploy-do1.sh, when it redeploys the SAME host
// that is currently running the Invoker owner that dispatched it (a
// "self-targeted" redeploy from Slack), sends SIGTERM to that owner's
// process group as its second-to-last step, then still has to run
// `systemctl --user restart slack-manager.service` + a wait loop.
//
// On the Invoker side that SIGTERM is caught by the owner
// (packages/app/src/main.ts:1067-1084 handleHeadlessTerminationSignal),
// which runs runHeadlessShutdownCleanup (main.ts:1025), which calls
// executorRegistry.destroyAll() on every executor factory
// (main.ts:1031-1032). WorktreeExecutor.destroyAll()
// (packages/execution-engine/src/worktree-executor.ts:658-680) then calls
// killProcessGroup(entry.process, 'SIGTERM')
// (packages/execution-engine/src/process-utils.ts:40-48, literally
// `process.kill(-child.pid, signal)`) on every still-running task --
// including the deploy-do1.sh task itself, since it is still blocked on
// its own remaining steps (restart slack-manager + wait for owner-serve).
//
// This script spawns a "task" child with detached:true (identical to
// worktree-executor.ts:453-458), has it touch a "fired" marker (stand-in
// for deploy-do1.sh's SIGTERM to the owner), and once the harness sees
// that marker it calls the real killProcessGroup() against the task's
// pid -- exactly what destroyAll() does. We then check whether the task's
// remaining steps (stand-in for `systemctl restart` + wait) still ran.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Verbatim: packages/execution-engine/src/process-utils.ts:40-48
function killProcessGroup(child, signal) {
  if (child.pid == null) return false;
  try {
    process.kill(-child.pid, signal);
    return true;
  } catch {
    return child.kill(signal);
  }
}

const workdir = mkdtempSync(join(tmpdir(), 'invoker-deploy-repro-'));

function taskScript(mode, firedMarker, doneMarker) {
  // Runs as the detached "task" process (pgid == its own pid).
  return `
    const { spawn } = require('node:child_process');
    const fs = require('node:fs');
    fs.writeFileSync(${JSON.stringify(firedMarker)}, '');   // <-- kill step fires
    function remaining(done) {
      setTimeout(() => { fs.writeFileSync(${JSON.stringify(doneMarker)}, 'ok'); done(); }, 300);
    }
    if (${JSON.stringify(mode)} === 'fixed') {
      // Detach the remaining steps into their OWN process group before the
      // kill above can land, so killing *this* task's group can't take
      // them down too. This is the fix: scripts/deploy-do1.sh now
      // backgrounds the stop/kill/restart/wait tail the same way.
      const grandchild = spawn(process.execPath, ['-e', \`
        setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(doneMarker)}, 'ok'), 300);
      \`], { detached: true, stdio: 'ignore' });
      grandchild.unref();
      process.exit(0);
    } else {
      remaining(() => process.exit(0));
      setInterval(() => {}, 1000); // keep event loop alive until remaining() exits us
    }
  `;
}

function runCase(mode) {
  return new Promise((resolve) => {
    const firedMarker = join(workdir, `${mode}.fired`);
    const doneMarker = join(workdir, `${mode}.done`);
    for (const f of [firedMarker, doneMarker]) rmSync(f, { force: true });

    // Identical spawn shape to worktree-executor.ts:453-458 / base-executor.ts:245-248
    const task = spawn(process.execPath, ['-e', taskScript(mode, firedMarker, doneMarker)], {
      detached: true,
      stdio: 'ignore',
    });

    const poll = setInterval(() => {
      if (existsSync(firedMarker)) {
        clearInterval(poll);
        // Identical to WorktreeExecutor.destroyAll() (worktree-executor.ts:658-680)
        killProcessGroup(task, 'SIGTERM');
        setTimeout(() => resolve(existsSync(doneMarker)), 700);
      }
    }, 20);
  });
}

const buggy = await runCase('buggy');
console.log('== BEFORE FIX: current scripts/deploy-do1.sh shape ==');
if (buggy) {
  console.log('UNEXPECTED PASS: restart step completed even though the task\'s own process group was killed');
  process.exit(1);
} else {
  console.log('REPRODUCED FAILURE: restart step never ran -- slack-manager would be left stopped forever');
}

console.log('');
const fixed = await runCase('fixed');
console.log('== AFTER FIX: remaining steps detached into their own process group ==');
if (fixed) {
  console.log('CONFIRMED PASS: restart step completed despite the task\'s process group being killed');
} else {
  console.log('FIX DID NOT WORK');
  process.exit(1);
}

rmSync(workdir, { recursive: true, force: true });
