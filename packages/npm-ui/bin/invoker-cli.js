#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let cliPackageJson;
try {
  cliPackageJson = require.resolve('@neko-catpital-labs/invoker-cli/package.json');
} catch {
  console.error(
    'The @neko-catpital-labs/invoker-cli dependency is not installed. Reinstall @neko-catpital-labs/invoker-ui.',
  );
  process.exit(1);
}

const binary = join(dirname(cliPackageJson), 'vendor', 'invoker-cli');

if (!existsSync(binary)) {
  console.error(
    `invoker-cli binary is missing at ${binary}. Its postinstall did not run or failed — ` +
      'reinstall @neko-catpital-labs/invoker-ui, or run `npm rebuild @neko-catpital-labs/invoker-cli`.',
  );
  process.exit(1);
}

const result = spawnSync(binary, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
