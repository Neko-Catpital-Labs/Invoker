#!/usr/bin/env node
// Verifies the invoker-cli bin wrapper: it must resolve the
// @neko-catpital-labs/invoker-cli dependency's vendor binary and spawn it,
// and emit a clear error when the vendor binary is missing (postinstall
// skipped/failed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const scratch = mkdtempSync(join(tmpdir(), 'invoker-ui-wrapper-'));

try {
  const pkgDir = join(scratch, 'pkg');
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  cpSync(join(packageRoot, 'bin', 'invoker-cli.js'), join(pkgDir, 'bin', 'invoker-cli.js'));
  writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'wrapper-under-test', type: 'module' }));

  const depDir = join(pkgDir, 'node_modules', '@neko-catpital-labs', 'invoker-cli');
  mkdirSync(join(depDir, 'vendor'), { recursive: true });
  writeFileSync(
    join(depDir, 'package.json'),
    JSON.stringify({ name: '@neko-catpital-labs/invoker-cli', version: '0.0.3' }),
  );

  // Missing vendor binary → clear reinstall hint, non-zero exit.
  let missingError = '';
  try {
    execFileSync(process.execPath, [join(pkgDir, 'bin', 'invoker-cli.js'), '--version'], { encoding: 'utf8' });
    assert.fail('expected the wrapper to exit non-zero when the vendor binary is missing');
  } catch (err) {
    missingError = String(err.stderr ?? '');
  }
  assert.match(missingError, /binary is missing/, `unexpected missing-vendor error: ${missingError}`);
  assert.match(missingError, /npm rebuild @neko-catpital-labs\/invoker-cli/);

  // Vendor binary present → wrapper spawns it and forwards args/exit code.
  const fakeBinary = join(depDir, 'vendor', 'invoker-cli');
  writeFileSync(fakeBinary, '#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo "0.0.3"; exit 0; fi\nexit 7\n');
  chmodSync(fakeBinary, 0o755);

  const version = execFileSync(process.execPath, [join(pkgDir, 'bin', 'invoker-cli.js'), '--version'], {
    encoding: 'utf8',
  }).trim();
  assert.equal(version, '0.0.3');

  try {
    execFileSync(process.execPath, [join(pkgDir, 'bin', 'invoker-cli.js'), 'not-a-flag'], { encoding: 'utf8' });
    assert.fail('expected the wrapper to forward the binary exit code');
  } catch (err) {
    assert.equal(err.status, 7);
  }

  console.log('ok invoker-ui invoker-cli wrapper');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
