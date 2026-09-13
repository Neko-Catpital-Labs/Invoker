import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installBundledSkills } from './bundled-skills.js';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(resourcesRoot: string, name: string, category?: string): void {
  const skillDir = join(resourcesRoot, 'skills', name);
  const categoryLine = category ? `category: ${category}\n` : '';
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n${categoryLine}description: test skill\n---\n\n# ${name}\n`,
  );
}

function installContext(resourcesRoot: string, invokerHomeRoot: string) {
  return {
    isPackaged: true,
    repoRoot: makeTempRoot('invoker-bundled-repo-'),
    resourcesPath: resourcesRoot,
    invokerHomeRoot,
    isInstalled: () => true,
  };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('installBundledSkills pruning', () => {
  it('removes a dropped bundled skill while preserving kept and non-prefixed folders', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const fakeHome = makeTempRoot('invoker-bundled-fakehome-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    writeSkill(resourcesRoot, 'kept');
    writeSkill(resourcesRoot, 'dropped');

    try {
      const context = installContext(resourcesRoot, invokerHomeRoot);
      installBundledSkills(context);

      for (const target of ['.codex/skills', '.claude/skills', '.cursor/skills', '.omp/agent/skills']) {
        mkdirSync(join(fakeHome, target, 'user-created'), { recursive: true });
      }
      rmSync(join(resourcesRoot, 'skills', 'dropped'), { recursive: true, force: true });
      installBundledSkills(context);

      for (const target of ['.codex/skills', '.claude/skills', '.cursor/skills', '.omp/agent/skills']) {
        const targetRoot = join(fakeHome, target);
        expect(existsSync(join(targetRoot, 'invoker-kept'))).toBe(true);
        expect(existsSync(join(targetRoot, 'invoker-dropped'))).toBe(false);
        expect(existsSync(join(targetRoot, 'user-created'))).toBe(true);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });

  it('keeps a still-bundled optimization skill during a core-filtered reinstall', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const fakeHome = makeTempRoot('invoker-bundled-fakehome-');
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    writeSkill(resourcesRoot, 'core-skill', 'core');
    writeSkill(resourcesRoot, 'optimization-skill', 'optimization');

    try {
      const context = installContext(resourcesRoot, invokerHomeRoot);
      installBundledSkills(context);
      installBundledSkills(context, 'install', 'core');

      for (const target of ['.codex/skills', '.claude/skills', '.cursor/skills', '.omp/agent/skills']) {
        expect(existsSync(join(fakeHome, target, 'invoker-core-skill'))).toBe(true);
        expect(existsSync(join(fakeHome, target, 'invoker-optimization-skill'))).toBe(true);
      }
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  });
});
