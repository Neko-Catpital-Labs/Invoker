import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  extractInsertResult,
  extractReleaseResult,
  insertRepairFiling,
  releaseRepairFiling,
} from './repair-filing-ledger.mjs';

const SCRIPT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'repair-filing-ledger.mjs');

describe('extractInsertResult', () => {
  it('reads the raw {inserted, row} line printed by a standalone owner', () => {
    const stdout = `${JSON.stringify({ inserted: true, row: { id: 1, kind: 'k', subject: 's', stateSha: 'sha', createdAt: 'now' } })}\n`;
    const result = extractInsertResult(stdout);
    assert.equal(result.inserted, true);
    assert.equal(result.row.id, 1);
  });

  it('unwraps the {ok, response} envelope printed by an IPC-delegated owner', () => {
    const stdout = `${JSON.stringify({
      args: ['repair-filing', 'insert'],
      ok: true,
      response: { inserted: false, row: { id: 2, kind: 'k', subject: 's', stateSha: 'sha', createdAt: 'now' } },
    })}\n`;
    const result = extractInsertResult(stdout);
    assert.equal(result.inserted, false);
    assert.equal(result.row.id, 2);
  });

  it('returns null for output with no matching JSON line', () => {
    assert.equal(extractInsertResult('not json\n{"ok":true}\n'), null);
  });

  it('scans from the last line backwards past unrelated log noise', () => {
    const stdout = [
      'some stderr-like line that leaked onto stdout',
      JSON.stringify({ inserted: true, row: { id: 3 } }),
    ].join('\n');
    const result = extractInsertResult(stdout);
    assert.equal(result.inserted, true);
  });
});

describe('extractReleaseResult', () => {
  it('reads the raw {released} line', () => {
    assert.deepEqual(extractReleaseResult(`${JSON.stringify({ released: true })}\n`), { released: true });
  });

  it('unwraps the {ok, response} envelope', () => {
    const stdout = `${JSON.stringify({ ok: true, response: { released: false } })}\n`;
    assert.deepEqual(extractReleaseResult(stdout), { released: false });
  });
});

describe('insertRepairFiling', () => {
  it('invokes headless_mutation via bash with argv-safe args (no string interpolation of caller data)', () => {
    let capturedCmd;
    let capturedArgs;
    const execFile = (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return `${JSON.stringify({ inserted: true, row: { id: 1 } })}\n`;
    };
    const result = insertRepairFiling(
      { kind: 'ci-regression:fleet', subject: 'master', stateSha: 'sha-a; rm -rf /' },
      { execFile },
    );
    assert.equal(result.inserted, true);
    assert.equal(capturedCmd, 'bash');
    assert.deepEqual(
      capturedArgs.slice(2),
      ['repair-filing-ledger', 'repair-filing', 'insert', '--kind', 'ci-regression:fleet', '--subject', 'master', '--state-sha', 'sha-a; rm -rf /'],
    );
  });

  it('passes --metadata as a single JSON-stringified argv entry', () => {
    let capturedArgs;
    const execFile = (_cmd, args) => {
      capturedArgs = args;
      return `${JSON.stringify({ inserted: true, row: { id: 1 } })}\n`;
    };
    insertRepairFiling(
      { kind: 'k', subject: 's', stateSha: 'sha', metadata: { memberJobs: ['a', 'b'] } },
      { execFile },
    );
    const metadataIndex = capturedArgs.indexOf('--metadata');
    assert.ok(metadataIndex !== -1);
    assert.deepEqual(JSON.parse(capturedArgs[metadataIndex + 1]), { memberJobs: ['a', 'b'] });
  });

  it('throws when the underlying output cannot be parsed (fails closed, never silently reports inserted:true)', () => {
    const execFile = () => 'garbage, not json\n';
    assert.throws(
      () => insertRepairFiling({ kind: 'k', subject: 's', stateSha: 'sha' }, { execFile }),
      /could not parse insert result/,
    );
  });

  it('requires kind, subject, and stateSha', () => {
    assert.throws(() => insertRepairFiling({ kind: '', subject: 's', stateSha: 'sha' }));
    assert.throws(() => insertRepairFiling({ kind: 'k', subject: '', stateSha: 'sha' }));
    assert.throws(() => insertRepairFiling({ kind: 'k', subject: 's', stateSha: '' }));
  });
});

describe('releaseRepairFiling', () => {
  it('invokes headless_mutation with the release subcommand', () => {
    let capturedArgs;
    const execFile = (_cmd, args) => {
      capturedArgs = args;
      return `${JSON.stringify({ released: true })}\n`;
    };
    const result = releaseRepairFiling({ kind: 'k', subject: 's', stateSha: 'sha' }, { execFile });
    assert.deepEqual(result, { released: true });
    assert.deepEqual(
      capturedArgs.slice(2),
      ['repair-filing-ledger', 'repair-filing', 'release', '--kind', 'k', '--subject', 's', '--state-sha', 'sha'],
    );
  });
});

describe('CLI (e2e, real subprocess)', () => {
  it('exits non-zero with usage text on an unknown command', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'bogus'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /unknown command/);
  });

  it('exits non-zero when a required flag is missing', () => {
    const result = spawnSync(process.execPath, [SCRIPT_PATH, 'insert', '--kind', 'k'], { encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /missing required flag/);
  });

  it('exits non-zero on invalid --metadata JSON', () => {
    const result = spawnSync(
      process.execPath,
      [SCRIPT_PATH, 'insert', '--kind', 'k', '--subject', 's', '--state-sha', 'sha', '--metadata', 'not-json'],
      { encoding: 'utf8' },
    );
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--metadata must be valid JSON/);
  });
});
