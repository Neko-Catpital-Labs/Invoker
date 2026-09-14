import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pinUiCliDependency } from './pin-npm-ui-cli-dependency.mjs';

const stage = mkdtempSync(join(tmpdir(), 'test-pin-npm-ui-cli-dependency-'));

function packFixture(name, version, dependencies) {
  const pkgDir = join(stage, `${name}-src`, 'package');
  mkdirSync(pkgDir, { recursive: true });
  writeFileSync(
    join(pkgDir, 'package.json'),
    JSON.stringify({ name, version, dependencies }, null, 2),
  );
  const tarballPath = join(stage, `${name}.tgz`);
  execFileSync('tar', ['-czf', tarballPath, '-C', join(stage, `${name}-src`), 'package']);
  return tarballPath;
}

try {
  const cliTarballPath = packFixture('@neko-catpital-labs/invoker-cli', '0.0.19', {});
  const uiTarballPath = packFixture('@neko-catpital-labs/invoker-ui', '0.0.19', {
    '@neko-catpital-labs/invoker-cli': '0.0.19',
  });
  const outputTarballPath = join(stage, 'pinned-ui.tgz');

  pinUiCliDependency(uiTarballPath, cliTarballPath, outputTarballPath);

  const extractDir = join(stage, 'extracted');
  mkdirSync(extractDir, { recursive: true });
  execFileSync('tar', ['-xzf', outputTarballPath, '-C', extractDir]);
  const pkg = JSON.parse(readFileSync(join(extractDir, 'package', 'package.json'), 'utf8'));

  assert.equal(
    pkg.dependencies['@neko-catpital-labs/invoker-cli'],
    `file:${resolve(cliTarballPath)}`,
    'pinned dependency must be a file: reference to the local cli tarball',
  );

  const noDependencyTarballPath = packFixture('@neko-catpital-labs/no-deps', '0.0.19', {});
  assert.throws(
    () => pinUiCliDependency(noDependencyTarballPath, cliTarballPath, join(stage, 'unused.tgz')),
    /no @neko-catpital-labs\/invoker-cli dependency to pin/,
    'must fail loudly when the ui tarball has no invoker-cli dependency to pin',
  );

  console.log('PASS: pin-npm-ui-cli-dependency.mjs pins invoker-cli to a local file: tarball');
} finally {
  rmSync(stage, { recursive: true, force: true });
}
