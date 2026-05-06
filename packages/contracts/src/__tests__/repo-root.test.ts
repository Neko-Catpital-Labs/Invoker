import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveRepoRoot } from '../repo-root.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  delete process.env.INVOKER_REPO_ROOT;
});

function makeTempRepo(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'invoker-repo-root-'));
  tempDirs.push(root);
  return root;
}

describe('resolveRepoRoot', () => {
  it('walks upward to find the workspace marker', () => {
    const repoRoot = makeTempRepo();
    writeFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
    const nestedDir = path.join(repoRoot, 'packages', 'app', 'src');
    mkdirSync(nestedDir, { recursive: true });

    expect(resolveRepoRoot(nestedDir)).toBe(repoRoot);
  });

  it('prefers the explicit environment override', () => {
    const repoRoot = makeTempRepo();
    const overrideRoot = makeTempRepo();
    writeFileSync(path.join(repoRoot, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n', 'utf8');
    process.env.INVOKER_REPO_ROOT = overrideRoot;

    expect(resolveRepoRoot(path.join(repoRoot, 'packages', 'app'))).toBe(overrideRoot);
  });

  it('uses the configured fallback when no marker exists', () => {
    const startDir = makeTempRepo();
    const fallbackRoot = makeTempRepo();

    expect(resolveRepoRoot(startDir, { fallback: fallbackRoot })).toBe(fallbackRoot);
  });

  it('throws when no marker or fallback is available', () => {
    const startDir = makeTempRepo();

    expect(() => resolveRepoRoot(startDir)).toThrow(`Could not resolve repo root from ${startDir}`);
  });
});
