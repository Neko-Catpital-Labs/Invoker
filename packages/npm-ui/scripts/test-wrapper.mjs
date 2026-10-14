#!/usr/bin/env node
// Verifies the invoker-cli bin wrapper: it must resolve the
// @neko-catpital-labs/invoker-cli dependency's vendor binary and spawn it,
// and emit a clear error when the vendor binary is missing (postinstall
// skipped/failed).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

// invoker-ui --help must print usage and exit 0 without touching the
// vendor Invoker.app (regression: it used to fall through to `open -a
// Invoker.app --args --help`, launching a real second GUI instance).
{
  const invokerUiBin = join(packageRoot, 'bin', 'invoker-ui.js');
  for (const flag of ['--help', '-h']) {
    const output = execFileSync(process.execPath, [invokerUiBin, flag], { encoding: 'utf8' });
    assert.match(output, /^Usage: invoker-ui/);
    assert.doesNotMatch(output, /Invoker\.app is missing/);
  }
  console.log('ok invoker-ui --help prints usage without launching the GUI');
}

// postinstall must wipe vendor/ and unzip with -o so a cancelled prior extract
// cannot leave dirs that block retry.
{
  const installSrc = readFileSync(join(packageRoot, 'scripts', 'install.js'), 'utf8');
  assert.match(installSrc, /rm\(vendor,\s*\{\s*recursive:\s*true,\s*force:\s*true\s*\}\)/);
  assert.match(installSrc, /unzip',\s*\['-qo'/);

  const retryRoot = mkdtempSync(join(tmpdir(), 'invoker-ui-install-retry-'));
  try {
    const vendor = join(retryRoot, 'vendor');
    mkdirSync(join(vendor, 'Invoker.app', 'Contents'), { recursive: true });
    writeFileSync(join(vendor, 'Invoker.app', 'Contents', 'stale'), 'stale');
    mkdirSync(join(vendor, '__MACOSX'), { recursive: true });
    writeFileSync(join(vendor, '__MACOSX', '._junk'), 'x');

    const zipSrc = join(retryRoot, 'zip-src');
    mkdirSync(join(zipSrc, 'Invoker.app', 'Contents'), { recursive: true });
    writeFileSync(join(zipSrc, 'Invoker.app', 'Contents', 'Info.plist'), 'fresh');
    const zipPath = join(retryRoot, 'Invoker.zip');
    execFileSync('zip', ['-qr', zipPath, 'Invoker.app'], { cwd: zipSrc });

    // Without a wipe, unzip over a partial vendor can keep stale paths that were
    // never in the new archive (and some unzip builds refuse same-path overwrites).
    try {
      execFileSync('unzip', ['-q', zipPath], { cwd: vendor, stdio: 'pipe' });
    } catch {
      // Some unzip builds exit non-zero when destinations already exist.
    }
    assert.equal(
      existsSync(join(vendor, 'Invoker.app', 'Contents', 'stale')),
      true,
      'expected leftover stale path to survive unzip without a vendor wipe',
    );

    rmSync(vendor, { recursive: true, force: true });
    mkdirSync(vendor, { recursive: true });
    cpSync(zipPath, join(vendor, 'Invoker.zip'));
    execFileSync('unzip', ['-qo', 'Invoker.zip'], { cwd: vendor, stdio: 'pipe' });
    assert.equal(existsSync(join(vendor, 'Invoker.app', 'Contents', 'Info.plist')), true);
    assert.equal(readFileSync(join(vendor, 'Invoker.app', 'Contents', 'Info.plist'), 'utf8'), 'fresh');
    assert.equal(existsSync(join(vendor, 'Invoker.app', 'Contents', 'stale')), false);
    assert.equal(existsSync(join(vendor, '__MACOSX')), false);
  } finally {
    rmSync(retryRoot, { recursive: true, force: true });
  }
  console.log('ok invoker-ui postinstall retry after partial vendor extract');
}
