#!/usr/bin/env node
// After tsup, dist/main.js must not keep a runtime import("@invoker/surfaces").
// npm 0.0.13 shipped surfaces inside app.asar but still failed owner-serve:
// the dynamic import loaded @slack/bolt → axios, and form-data was omitted
// from the asar. Bundling surfaces (and bolt) into main.js removes that edge.
const { readFileSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const mainPath = join(__dirname, '..', 'dist', 'main.js');
if (!existsSync(mainPath)) {
  console.error(`FAIL: ${mainPath} does not exist; build @invoker/app first`);
  process.exit(1);
}

const main = readFileSync(mainPath, 'utf8');
if (/import\(\s*['"]@invoker\/surfaces['"]\s*\)/.test(main)) {
  console.error('FAIL: packages/app/dist/main.js still dynamically imports @invoker/surfaces');
  process.exit(1);
}

console.log('PASS: packages/app/dist/main.js does not dynamically import @invoker/surfaces');
