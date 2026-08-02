#!/usr/bin/env node
/**
 * REPRO Issue 7 — The "executing"-phase failures are SSH/OAuth infra, not the
 * task's own work. The pnpm "Failed to create bin" WARN is a RED HERRING.
 *
 * Two tasks failed deep in `executing` with output that looks like a pnpm
 * install problem. The real fatal line, further down the same output, is the
 * SshExecutor auth failure — the identical OAuth-expiry root cause as the
 * crashes. A third task shows the "executing" + "Application quit" mislabel.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { assert, done } from './lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const OAUTH = 'Failed to authenticate: OAuth session expired and could not be refreshed';

function failed(file) {
  const t = JSON.parse(readFileSync(path.join(here, 'fixtures', file), 'utf8'))
    .find(x => x.status === 'failed');
  return { id: t.id, ...t.execution };
}

for (const file of [
  'task-executing-oauth-wf-1785596310942-167.json',
  'task-executing-oauth-wf-1785609264285-44.json',
]) {
  const e = failed(file);
  const hasWarn = e.error.includes('Failed to create bin');
  const hasOauth = e.error.includes(OAUTH) && e.error.includes('[SshExecutor]');
  assert(
    `${e.id.split('/').pop()}: pnpm WARN present but real fatal cause is SSH OAuth expiry`,
    e.phase === 'executing' && hasWarn && hasOauth,
    [`phase=${e.phase}  pnpm-warn=${hasWarn}  ssh-oauth-fatal=${hasOauth}`],
  );
}

// The other "executing" bucket is the same crash mislabel, just on a running task.
const appquit = failed('task-appquit-executing-wf-1785622621648-17.json');
assert(
  'a running (executing) task orphaned by the crash is also flattened to "Application quit"',
  appquit.phase === 'executing' && appquit.error === 'Application quit',
  [`${appquit.id}: error="${appquit.error}" phase=${appquit.phase}`],
);

done('"executing" failures are OAuth/SSH infra (pnpm warn is noise) or the crash mislabel — never task-logic bugs');
