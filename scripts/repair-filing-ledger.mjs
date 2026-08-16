#!/usr/bin/env node
// Shared cross-system dedup primitive for auto-filed CI/PR repair work.
//
// Backing store: the `repair_filings` SQLite table (see
// packages/data-store/src/sqlite-schema.ts), keyed on a composite
// (kind, subject, stateSha) UNIQUE index. The insert is atomic -- a single
// `INSERT ... ON CONFLICT DO NOTHING` statement inside a transaction -- so
// two callers racing on the identical key never both "win"; exactly one of
// them observes `inserted: true`.
//
// Both scripts/e2e-regression-watch.mjs (in-process, imports insertRepairFiling
// directly) and the mergify_admin_requeue Python scripts (out-of-process, via
// this file's CLI) call the same primitive so their dedup state lives in one
// place and each system can see the other's filings.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = dirname(dirname(__filename));

function runHeadlessMutation(args, { execFile = execFileSync } = {}) {
  // Args are passed as real argv entries to `bash -c '... "$@"'` (never
  // string-interpolated into the script itself), so a kind/subject/stateSha
  // value can't break out of the intended command line.
  const script = `source "${join(REPO_ROOT, 'scripts', 'headless-lib.sh')}" && headless_mutation "$@"`;
  return execFile('bash', ['-c', script, 'repair-filing-ledger', ...args], {
    encoding: 'utf8',
    cwd: REPO_ROOT,
    timeout: 90_000,
    killSignal: 'SIGKILL',
  });
}

/**
 * Pull the `{inserted, row}` result out of headless_mutation's stdout.
 *
 * Shape differs by delegation path: a standalone owner (`run.sh --headless`)
 * prints the raw `{inserted, row}` line from headlessRepairFiling; an
 * IPC-delegated owner (`headless-ipc.js exec`) wraps it as
 * `{..., ok: true, response: {inserted, row}}`. Scan from the last line
 * backwards and accept either shape.
 */
export function extractInsertResult(stdout) {
  return extractResult(stdout, (candidate) => typeof candidate.inserted === 'boolean' && candidate.row);
}

export function extractReleaseResult(stdout) {
  return extractResult(stdout, (candidate) => typeof candidate.released === 'boolean');
}

function extractResult(stdout, matches) {
  const lines = String(stdout ?? '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let parsed;
    try {
      parsed = JSON.parse(lines[i]);
    } catch {
      continue;
    }
    if (!parsed || typeof parsed !== 'object') continue;
    if (matches(parsed)) return parsed;
    if (parsed.response && typeof parsed.response === 'object' && matches(parsed.response)) {
      return parsed.response;
    }
  }
  return null;
}

/**
 * Atomic insert-if-not-exists for the (kind, subject, stateSha) dedup key.
 * Returns `{ inserted, row }`. Fails closed: a malformed/unparseable
 * response throws rather than silently returning `inserted: true`, so a
 * caller can never mistake a broken plumbing call for "safe to file".
 */
export function insertRepairFiling({ kind, subject, stateSha, metadata }, opts = {}) {
  if (!kind || !subject || !stateSha) {
    throw new Error('insertRepairFiling requires kind, subject, and stateSha');
  }
  const args = ['repair-filing', 'insert', '--kind', kind, '--subject', subject, '--state-sha', stateSha];
  if (metadata !== undefined && metadata !== null) {
    args.push('--metadata', JSON.stringify(metadata));
  }
  const stdout = runHeadlessMutation(args, opts);
  const result = extractInsertResult(stdout);
  if (!result) {
    throw new Error(`repair-filing-ledger: could not parse insert result from headless_mutation output: ${JSON.stringify(stdout)}`);
  }
  return result;
}

/**
 * Release a previously-claimed (kind, subject, stateSha) row. Call this when
 * insertRepairFiling returned `inserted: true` but the actual repair filing
 * then failed downstream -- without releasing the claim, a transient render/
 * lint/submit error would permanently block every future retry attempt for
 * that key, since the row would otherwise never go away on its own.
 */
export function releaseRepairFiling({ kind, subject, stateSha }, opts = {}) {
  if (!kind || !subject || !stateSha) {
    throw new Error('releaseRepairFiling requires kind, subject, and stateSha');
  }
  const args = ['repair-filing', 'release', '--kind', kind, '--subject', subject, '--state-sha', stateSha];
  const stdout = runHeadlessMutation(args, opts);
  const result = extractReleaseResult(stdout);
  if (!result) {
    throw new Error(`repair-filing-ledger: could not parse release result from headless_mutation output: ${JSON.stringify(stdout)}`);
  }
  return result;
}

function usage() {
  return [
    'Usage: node scripts/repair-filing-ledger.mjs insert --kind <kind> --subject <subject> --state-sha <sha> [--metadata <json>]',
    '   or: node scripts/repair-filing-ledger.mjs release --kind <kind> --subject <subject> --state-sha <sha>',
    'insert prints: {"inserted":true|false,"row":{...}}',
    '  inserted=true  -- this call created the row; caller should proceed and file the repair.',
    '  inserted=false -- an identical (kind, subject, stateSha) row already existed; caller should skip filing.',
    'release prints: {"released":true|false} -- call after a claimed insert whose filing then failed, to allow a later retry.',
  ].join('\n');
}

function parseInsertFlags(argv) {
  const flags = {};
  let i = 0;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--kind' || arg === '--subject' || arg === '--state-sha' || arg === '--metadata') {
      const key = arg === '--state-sha' ? 'stateSha' : arg.slice(2);
      flags[key] = argv[i + 1];
      i += 2;
    } else {
      throw new Error(`Unrecognized argument: "${arg}"`);
    }
  }
  return flags;
}

export async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;
  if (command !== 'insert' && command !== 'release') {
    console.error(`repair-filing-ledger: unknown command "${command ?? ''}"\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  let flags;
  try {
    flags = parseInsertFlags(rest);
  } catch (err) {
    console.error(`repair-filing-ledger: ${err.message}\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }
  if (!flags.kind || !flags.subject || !flags.stateSha) {
    console.error(`repair-filing-ledger: missing required flag\n\n${usage()}`);
    process.exitCode = 1;
    return;
  }

  if (command === 'release') {
    try {
      const result = releaseRepairFiling({ kind: flags.kind, subject: flags.subject, stateSha: flags.stateSha });
      process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (err) {
      console.error(`repair-filing-ledger: ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    }
    return;
  }

  let metadata;
  if (flags.metadata !== undefined) {
    try {
      metadata = JSON.parse(flags.metadata);
    } catch (err) {
      console.error(`repair-filing-ledger: --metadata must be valid JSON: ${err.message}`);
      process.exitCode = 1;
      return;
    }
  }
  try {
    const result = insertRepairFiling({ kind: flags.kind, subject: flags.subject, stateSha: flags.stateSha, metadata });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (err) {
    console.error(`repair-filing-ledger: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}

const isMain = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    console.error('repair-filing-ledger: fatal error', err);
    process.exitCode = 1;
  });
}
