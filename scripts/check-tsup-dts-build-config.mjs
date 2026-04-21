#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const packagesDir = path.join(repoRoot, 'packages');

const ALLOWED_DTS_TSCONFIGS = new Set(['tsconfig.build.json', 'tsconfig.tsup.json']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function extractScriptTsconfig(buildScript) {
  const match = buildScript.match(/--tsconfig\s+([^\s]+)/);
  return match ? match[1].replace(/^["']|["']$/g, '') : undefined;
}

function extractConfigTsconfig(tsupConfigSource) {
  const match = tsupConfigSource.match(/\btsconfig\s*:\s*['"]([^'"]+)['"]/);
  return match ? match[1] : undefined;
}

function configEnablesDts(buildScript, tsupConfigSource) {
  if (typeof buildScript === 'string' && buildScript.includes('--dts')) {
    return true;
  }
  return /\bdts\s*:/.test(tsupConfigSource);
}

function resolvePackageTsconfig(packageDir, tsconfigRef) {
  if (!tsconfigRef) return undefined;
  return path.resolve(packageDir, tsconfigRef);
}

function assertDedicatedNonCompositeTsconfig(packageName, packageDir, tsconfigRef, failures) {
  if (!tsconfigRef) {
    failures.push(`${packageName}: missing explicit tsconfig for tsup DTS build`);
    return;
  }

  const baseName = path.basename(tsconfigRef);
  if (!ALLOWED_DTS_TSCONFIGS.has(baseName)) {
    failures.push(
      `${packageName}: tsup DTS build uses disallowed tsconfig "${tsconfigRef}" (expected one of ${Array.from(ALLOWED_DTS_TSCONFIGS).join(', ')})`,
    );
    return;
  }

  const tsconfigPath = resolvePackageTsconfig(packageDir, tsconfigRef);
  if (!tsconfigPath || !fs.existsSync(tsconfigPath)) {
    failures.push(`${packageName}: referenced tsconfig "${tsconfigRef}" does not exist`);
    return;
  }

  const tsconfig = readJson(tsconfigPath);
  if (tsconfig?.compilerOptions?.composite !== false) {
    failures.push(`${packageName}: ${tsconfigRef} must set compilerOptions.composite=false`);
  }
}

const failures = [];
const checkedPackages = [];

for (const entry of fs.readdirSync(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageDir = path.join(packagesDir, entry.name);
  const packageJsonPath = path.join(packageDir, 'package.json');
  if (!fs.existsSync(packageJsonPath)) continue;

  const pkg = readJson(packageJsonPath);
  const buildScript = pkg?.scripts?.build;
  const tsupConfigPath = path.join(packageDir, 'tsup.config.ts');
  const tsupConfigSource = fs.existsSync(tsupConfigPath)
    ? fs.readFileSync(tsupConfigPath, 'utf8')
    : '';

  const usesTsup = (typeof buildScript === 'string' && /\btsup\b/.test(buildScript)) || tsupConfigSource.length > 0;
  if (!usesTsup) continue;

  if (!configEnablesDts(buildScript, tsupConfigSource)) continue;

  const tsconfigRef = fs.existsSync(tsupConfigPath)
    ? extractConfigTsconfig(tsupConfigSource)
    : extractScriptTsconfig(buildScript);

  checkedPackages.push({
    packageName: pkg.name ?? entry.name,
    packageDir,
    tsconfigRef: tsconfigRef ?? '(missing)',
  });
  assertDedicatedNonCompositeTsconfig(pkg.name ?? entry.name, packageDir, tsconfigRef, failures);
}

if (checkedPackages.length === 0) {
  console.error('No tsup DTS packages found to validate.');
  process.exit(1);
}

console.log('Validated tsup DTS build config for:');
for (const checked of checkedPackages) {
  console.log(`- ${checked.packageName}: ${checked.tsconfigRef}`);
}

if (failures.length > 0) {
  console.error('\nFailures:');
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log('\nAll tsup DTS packages use dedicated non-composite tsconfigs.');
