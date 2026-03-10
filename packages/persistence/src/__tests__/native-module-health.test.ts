import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { createRequire } from 'module';
import Database from 'better-sqlite3';

const require = createRequire(import.meta.url);

function resolveBinaryPath(): string {
  const pkgPath = require.resolve('better-sqlite3/package.json');
  return join(dirname(pkgPath), 'build', 'Release', 'better_sqlite3.node');
}

describe('native module health check', () => {
  it('better-sqlite3 binary exists at expected path', () => {
    const binaryPath = resolveBinaryPath();
    expect(
      existsSync(binaryPath),
      `Native binary not found at ${binaryPath}. Run: pnpm rebuild better-sqlite3`
    ).toBe(true);
  });

  it('better-sqlite3 binary MODULE_VERSION matches runtime', () => {
    const binaryPath = resolveBinaryPath();
    const nm = execSync(`nm -D "${binaryPath}" 2>/dev/null || nm "${binaryPath}"`, {
      encoding: 'utf8',
    });
    const match = nm.match(/node_register_module_v(\d+)/);
    expect(match, 'Could not find node_register_module_v symbol in binary').not.toBeNull();

    const binaryVersion = parseInt(match![1], 10);
    const runtimeVersion = parseInt(process.versions.modules, 10);
    expect(
      binaryVersion,
      `Binary compiled for MODULE_VERSION ${binaryVersion} but running MODULE_VERSION ${runtimeVersion}. Run: pnpm rebuild better-sqlite3`
    ).toBe(runtimeVersion);
  });

  it('better-sqlite3 loads and executes a query', () => {
    const db = new Database(':memory:');
    const row = db.prepare('SELECT 1 + 1 AS result').get() as { result: number };
    expect(row.result).toBe(2);
    db.close();
  });
});
