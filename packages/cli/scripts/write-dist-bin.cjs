const { chmodSync, mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { version } = require('../package.json');

const distDir = join(__dirname, '..', 'dist');
mkdirSync(distDir, { recursive: true });

const binPath = join(distDir, 'index.js');
writeFileSync(binPath, `#!/usr/bin/env node
if (process.argv.length === 3 && (process.argv[2] === '--version' || process.argv[2] === '-v')) {
  require('node:fs').writeSync(1, ${JSON.stringify(`${version}\n`)});
  process.exit(0);
} else {
  eval(\`
  const argv = process.argv.slice(2);
  import('./cli-runtime.mjs').then(async (runtime) => {
    process.exitCode = await runtime.main(argv);
  }, (err) => {
    process.stderr.write((err instanceof Error ? err.message : String(err)) + '\\\\n');
    process.exitCode = 1;
  });
  \`);
}
`);
chmodSync(binPath, 0o755);

writeFileSync(join(distDir, 'package.json'), '{"type":"commonjs"}\n');
