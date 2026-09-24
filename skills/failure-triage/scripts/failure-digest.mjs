#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function classifyError(error) {
  const text = error || '';
  if (
    /Installing managed worktree dependencies/.test(text) &&
    !/Running task payload/.test(text)
  ) {
    return 'ssh-provision-death';
  }
  if (/ERR_MODULE_NOT_FOUND/.test(text)) return 'missing-node-deps';
  if (/carries \d+ review claims/.test(text) || /would publish as one PR/.test(text)) {
    return 'merge-gate-multi-claim';
  }
  if (/usage limit|rate limit/i.test(text)) return 'usage-limit';
  if (/fatal: invalid reference/.test(text)) return 'ssh-infra';
  if (/env\.sh'.*not a valid identifier/.test(text)) return 'ssh-infra';
  if (/No space left on device/.test(text)) return 'ssh-infra';
  if (/worktree.*corrupt|repo mirror corrupt/i.test(text)) return 'ssh-infra';
  if (/does not exist in remote/.test(text)) return 'ssh-infra';
  if (/Merge failed/.test(text)) return 'merge-other';
  return 'code-or-precondition';
}

export const CLASS_OWNERS = {
  'ssh-provision-death': 'infra-repair',
  'ssh-infra': 'infra-repair',
  'missing-node-deps': 'infra/provision wiring',
  'merge-gate-multi-claim': 'human replan (chain or split-publish)',
  'merge-other': 'human (merge gate)',
  'usage-limit': 'quota/backoff',
  'code-or-precondition': 'autofix if eligible, else human',
};

function cli(args) {
  try {
    const out = execFileSync('invoker-cli', args, { encoding: 'utf8', maxBuffer: 64 << 20 });
    return JSON.parse(out);
  } catch (e) {
    return { error: String(e.stderr || e.message).slice(0, 300) };
  }
}

function foldAutofixLedger(logPath) {
  const ledger = { tasks: {}, counts: {} };
  let lines;
  try {
    lines = readFileSync(logPath, 'utf8').split('\n');
  } catch {
    return ledger;
  }
  for (const line of lines) {
    if (!line.includes('worker-autofix')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const m = /worker-autofix-[\w-]+/.exec(String(rec.msg || ''));
    if (!m) continue;
    const msg = m[0];
    ledger.counts[msg] = (ledger.counts[msg] || 0) + 1;
    const taskId = rec.taskId;
    if (!taskId) continue;
    const t = (ledger.tasks[taskId] ||= { lastEvent: '', reason: '', skips: 0 });
    t.lastEvent = msg;
    if (msg === 'worker-autofix-skip') {
      t.skips += 1;
      if (typeof rec.reason === 'string') t.reason = rec.reason;
    } else {
      t.reason = '';
    }
  }
  return ledger;
}

export function disposition(cls, ledgerEntry) {
  if (cls === 'merge-gate-multi-claim') return 'replan: split-publish or chain, do not retry';
  if (cls === 'ssh-provision-death' || cls === 'ssh-infra') {
    return 'infra-repair owns it; if failureClass unset, classifier missed it (generic autofix burns budget)';
  }
  if (cls === 'usage-limit') return 'wait for quota reset; autofix skips by design';
  if (ledgerEntry?.lastEvent === 'worker-autofix-skip') {
    const reason = ledgerEntry.reason || '';
    if (reason.includes('budget-exhausted')) return 'autofix budget exhausted — manual retry or resubmit';
    if (reason.includes('not-eligible')) return 'autofix-ineligible (child/recon/cancel) — parent or human owns';
    if (reason.includes('already-queued')) return 'fix intent already queued — wait';
    return `autofix skipped (${reason || 'unknown'})`;
  }
  if (ledgerEntry?.lastEvent?.includes('submitted')) return 'autofix fix-with-agent dispatched';
  if (cls === 'missing-node-deps') return 'check repoProvisionCommands covers this repoUrl on that executor';
  return 'autofix-eligible code/precondition failure — but verify resubmit-sibling first';
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const logIdx = argv.indexOf('--log');
  const logPath = logIdx >= 0 ? argv[logIdx + 1] : join(homedir(), '.invoker', 'invoker.log');

  const workflows = cli(['query', 'workflows', '--output', 'json']);
  const wfList = Array.isArray(workflows) ? workflows : [];
  const counts = {};
  for (const w of wfList) counts[w.status] = (counts[w.status] || 0) + 1;
  const failedWfs = wfList.filter((w) => w.status === 'failed');

  const ledger = foldAutofixLedger(logPath);
  const classes = {};
  for (const wf of failedWfs) {
    const tasks = cli(['query', 'tasks', '--workflow', wf.id, '--status', 'failed', '--output', 'json']);
    const list = Array.isArray(tasks) ? tasks : [];
    for (const t of list) {
      const err = t?.execution?.error || t?.result?.error || '';
      const cls = classifyError(err);
      const le = ledger.tasks[t.id];
      (classes[cls] ||= []).push({
        workflowId: wf.id,
        taskId: t.id,
        member: t?.config?.poolMemberId || t?.config?.runnerKind || '',
        failureClass: t?.execution?.failureClass || null,
        autofix: le ? `${le.lastEvent}${le.reason ? `:${le.reason}` : ''}` : 'no-ledger-entry',
        errorTail: err.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 160) || '',
      });
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ counts, classes, autofixLedger: ledger.counts }, null, 2));
    return;
  }

  console.log('Workflow status counts:', JSON.stringify(counts));
  console.log(`Autofix ledger events: ${JSON.stringify(ledger.counts)}`);
  console.log('');
  for (const [cls, items] of Object.entries(classes).sort((a, b) => b[1].length - a[1].length)) {
    console.log(`== ${cls} (${items.length}) → ${CLASS_OWNERS[cls] || 'unclassified'}`);
    const seen = new Set();
    for (const it of items) {
      const key = `${it.member}|${it.autofix}`;
      if (seen.has(key) && items.length > 6) continue;
      seen.add(key);
      console.log(
        `   ${it.taskId} @${it.member || '?'} class=${it.failureClass || 'unset'} autofix=${it.autofix}`,
      );
      console.log(`     ${it.errorTail}`);
      console.log(`     → ${disposition(cls, ledger.tasks[it.taskId])}`);
    }
    console.log('');
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
