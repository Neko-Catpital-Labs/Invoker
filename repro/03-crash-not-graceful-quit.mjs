#!/usr/bin/env node
/**
 * REPRO Issue 3 — The app did NOT gracefully quit; the owner CRASHED and was
 * relaunched. "Application quit" is applied by the boot orphan-reconcile.
 *
 * Proof, straight from ~/.invoker/invoker.log over the incident window:
 *   (a) ZERO graceful "before-quit begin" events in 01:00–01:45.
 *   (b) The boot reconcile logged "left by a previous owner crash" TWICE
 *       (01:24 and 01:40), each failing a batch of in-flight tasks.
 *   (c) Only 2 distinct owner ids in the window → 2 crash/relaunch handoffs.
 */
import { readLogLines, WINDOW_RE, assert, done } from './lib.mjs';

const lines = readLogLines().filter(l => WINDOW_RE.test(l));

// (a) graceful-quit path never ran in the window
const beforeQuit = lines.filter(l => l.includes('"before-quit begin"'));
assert(
  'no graceful "before-quit begin" in 01:00–01:45 window',
  beforeQuit.length === 0,
  beforeQuit.slice(0, 3).map(l => l.slice(0, 120)),
);

// (b) boot orphan-reconcile fired once per owner crash — assert EACH event
const crashReconciles = lines
  .filter(l => l.includes('left by a previous owner crash'))
  .map(l => JSON.parse(l))
  .map(t => ({ time: t.time, count: Number((t.msg.match(/failed (\d+)/) || [])[1] || 0), n: t.taskIds?.length ?? 0 }));
assert(
  'boot reconcile fired on >=2 distinct "previous owner crash" events',
  crashReconciles.length >= 2,
  crashReconciles.map(c => `${c.time}  failed ${c.count} orphaned task(s)  (taskIds=${c.n})`),
);
for (const c of crashReconciles) {
  assert(
    `crash @ ${c.time}: reported count matches the taskIds it actually failed`,
    c.count > 0 && c.count === c.n,
    [`count=${c.count} taskIds=${c.n}`],
  );
}

// (c) owner handoffs = crashes: count distinct owner ids in the window
const owners = new Set();
for (const l of lines) {
  const m = l.match(/owner-\d+-\d+/);
  if (m) owners.add(m[0]);
}
assert(
  'multiple owner generations in window (>=2) → crash/relaunch handoffs',
  owners.size >= 2,
  [`${owners.size} distinct owners: ${[...owners].join(', ')}`],
);

done('the owner crashed & relaunched — this was not a graceful "Application quit"');
