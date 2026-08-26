#!/usr/bin/env node
/**
 * Audit an agent transcript/log for prohibited NiceSpeak source access.
 * Exit 0 when clean; exit 2 when leakage signatures are found.
 */

import { readFileSync } from 'node:fs';

const NEEDLES = [
  /Neko-Catpital-Labs\/NiceSpeak/i,
  /github\.com\/Neko-Catpital-Labs\/NiceSpeak/i,
  /\/NiceSpeak\/(apps|test|evals)\b/,
  /git\s+clone[^\n]*NiceSpeak/i,
  /gh\s+api[^\n]*NiceSpeak/i,
];

function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('Usage: node audit-transcript.mjs <transcript-file>');
    process.exit(1);
  }
  const text = readFileSync(file, 'utf8');
  const hits = [];
  for (const needle of NEEDLES) {
    const match = text.match(needle);
    if (match) hits.push(match[0]);
  }
  if (hits.length > 0) {
    console.error(JSON.stringify({ ok: false, hits }, null, 2));
    process.exit(2);
  }
  console.log(JSON.stringify({ ok: true, hits: [] }));
}

main();
