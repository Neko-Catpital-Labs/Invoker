#!/usr/bin/env node
/**
 * REPRO Issue 4 — Root cause is SSH execution-pool infra, not the app.
 *
 * Proof from ~/.invoker/invoker.log over the incident window:
 *   (a) The admin-bypass worker attributes repeated repair crashes to an SSH
 *       infra failure: "OAuth session expired and could not be refreshed".
 *   (b) Remote disk pressure warnings (do_3 >=85%, do_4 >=92%) at the same time.
 *   (c) The launch-dispatcher repeatedly "abandoned" dispatched launches
 *       (the stuck-in-launching signature that later gets orphan-reconciled).
 */
import { readLogLines, WINDOW_RE, assert, done } from './lib.mjs';

const lines = readLogLines().filter(l => WINDOW_RE.test(l));

// (a) SSH OAuth-expired infra failure explicitly named as the crash cause
const oauth = lines.filter(l =>
  l.includes('OAuth session expired and could not be refreshed')
  && /SSH execution-pool infra failure/.test(l));
assert(
  'SSH execution-pool infra failure (OAuth session expired) present',
  oauth.length > 0,
  oauth.slice(0, 1).map(l => {
    const t = JSON.parse(l);
    const i = t.msg.indexOf('SSH execution-pool infra failure');
    return `${t.time}  …${t.msg.slice(i, i + 120)}…`;
  }),
);

// (b) remote disk pressure at the same time
const disk = lines.filter(l => l.includes('[disk-headroom] warn'));
const worstPct = Math.max(0, ...disk.map(l => (JSON.parse(l).usedPercent ?? 0)));
assert(
  'remote disk-headroom warnings present (>=85% used)',
  disk.length > 0 && worstPct >= 85,
  disk.slice(0, 4).map(l => { const t = JSON.parse(l); return `${t.time}  ${t.msg}`; }),
);

// (c) launch-dispatcher abandoned launches (stuck-in-launching signature)
const abandoned = lines.filter(l => l.includes('[launch-dispatcher] abandoned'));
const abandonedCount = abandoned.reduce((n, l) => n + (JSON.parse(l).count ?? 0), 0);
assert(
  'launch-dispatcher abandoned dispatched launches (stuck in launching)',
  abandonedCount > 0,
  [`total abandoned launches in window: ${abandonedCount} across ${abandoned.length} events`],
);

done('root cause = SSH/OAuth infra + remote disk pressure, not the application');
