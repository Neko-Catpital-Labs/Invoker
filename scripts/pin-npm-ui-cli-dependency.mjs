#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const DEPENDENCY_NAME = '@neko-catpital-labs/invoker-cli';

export function pinUiCliDependency(uiTarballPath, cliTarballPath, outputTarballPath) {
  const stage = mkdtempSync(join(tmpdir(), 'pin-npm-ui-cli-dependency-'));
  try {
    execFileSync('tar', ['-xzf', resolve(uiTarballPath), '-C', stage]);
    const pkgPath = join(stage, 'package', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (!pkg.dependencies?.[DEPENDENCY_NAME]) {
      throw new Error(`${uiTarballPath} package.json has no ${DEPENDENCY_NAME} dependency to pin`);
    }
    pkg.dependencies[DEPENDENCY_NAME] = `file:${resolve(cliTarballPath)}`;
    writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    execFileSync('tar', ['-czf', resolve(outputTarballPath), '-C', stage, 'package']);
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [, , uiTarballPath, cliTarballPath, outputTarballPath] = process.argv;
  if (!uiTarballPath || !cliTarballPath || !outputTarballPath) {
    console.error('Usage: pin-npm-ui-cli-dependency.mjs <ui-tarball> <cli-tarball> <output-tarball>');
    process.exit(64);
  }
  pinUiCliDependency(uiTarballPath, cliTarballPath, outputTarballPath);
  console.log(outputTarballPath);
}
