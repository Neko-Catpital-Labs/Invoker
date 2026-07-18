#!/usr/bin/env node
// Extract one CHANGELOG.md version section for GitHub Release notes.
//
//   node scripts/extract-changelog-section.mjs 0.0.7
//   node scripts/extract-changelog-section.mjs 0.0.7 --out release-notes.md
//
// Prints markdown for "## <version>" through the line before the next "## ".
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

export function extractChangelogSection(changelog, version) {
  const heading = `## ${version}`;
  const lines = String(changelog).split('\n');
  const start = lines.findIndex((line) => line.trim() === heading);
  if (start === -1) {
    throw new Error(`CHANGELOG.md has no "${heading}" section`);
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^##\s+/.test(lines[i])) {
      end = i;
      break;
    }
  }

  const body = lines.slice(start + 1, end).join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
  if (!body.trim()) {
    throw new Error(`CHANGELOG.md section "${heading}" is empty`);
  }

  return [`# Invoker ${version}`, '', body, ''].join('\n');
}

function main() {
  const version = process.argv[2];
  if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
    console.error('Usage: node scripts/extract-changelog-section.mjs <semver> [--out <file>]');
    process.exit(64);
  }

  let outPath;
  for (let i = 3; i < process.argv.length; i += 1) {
    if (process.argv[i] === '--out') {
      outPath = process.argv[i + 1];
      i += 1;
    }
  }

  const notes = extractChangelogSection(readFileSync(join(root, 'CHANGELOG.md'), 'utf8'), version);
  if (outPath) {
    writeFileSync(outPath, notes);
    console.log(outPath);
  } else {
    process.stdout.write(notes);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
