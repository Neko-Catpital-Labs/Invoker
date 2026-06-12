//@ts-check
// node-pty@1.1.0 publishes its prebuilt `spawn-helper` binaries without the
// executable bit (the npm tarball entry is mode 0644), so every fresh
// `pnpm install` materializes a helper that posix_spawnp cannot exec. The
// embedded terminal then fails to spawn any session. Re-apply the bit after
// install. See https://github.com/microsoft/node-pty for the upstream package.
//
// Usage: node scripts/fix-node-pty-spawn-helper.mjs [rootDir]

import { globSync, chmodSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

if (process.platform === 'win32') {
  process.exit(0);
}

const root = path.resolve(process.argv[2] ?? process.cwd());
const patterns = [
  'node_modules/.pnpm/node-pty@*/node_modules/node-pty/prebuilds/*/spawn-helper',
  'node_modules/node-pty/prebuilds/*/spawn-helper',
  'node_modules/.pnpm/node-pty@*/node_modules/node-pty/build/Release/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
];

let fixed = 0;
for (const pattern of patterns) {
  for (const file of globSync(pattern, { cwd: root })) {
    const target = path.join(root, file);
    try {
      const mode = statSync(target).mode;
      if ((mode & 0o111) === 0o111) continue;
      chmodSync(target, mode | 0o111);
      fixed += 1;
      console.log(`[fix-node-pty] restored exec permission: ${file}`);
    } catch (err) {
      // A missed chmod degrades embedded terminals but must not fail install.
      console.warn(`[fix-node-pty] could not fix ${file}: ${err instanceof Error ? err.message : err}`);
    }
  }
}

if (fixed === 0) {
  console.log('[fix-node-pty] spawn-helper permissions already correct (or node-pty absent)');
}
