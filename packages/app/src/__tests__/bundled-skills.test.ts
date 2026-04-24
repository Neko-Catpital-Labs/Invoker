import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { installBundledSkills, resolveBundledSkillsStatus } from '../bundled-skills.js';

const tempRoots: string[] = [];

function makeTempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function writeSkill(sourceRoot: string, name: string): void {
  const skillDir = join(sourceRoot, 'skills', name);
  mkdirSync(join(skillDir, 'scripts'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), `# ${name}\n`);
  writeFileSync(join(skillDir, 'scripts', 'check.sh'), '#!/usr/bin/env bash\necho ok\n');
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('bundled-skills', () => {
  it('reports promptRecommended for packaged apps before skills are installed', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');

    writeSkill(resourcesRoot, 'plan-to-invoker');
    writeSkill(resourcesRoot, 'make-pr');

    const status = resolveBundledSkillsStatus({
      isPackaged: true,
      repoRoot,
      resourcesPath: resourcesRoot,
      invokerHomeRoot,
    });

    expect(status.available).toBe(true);
    expect(status.promptRecommended).toBe(true);
    expect(status.bundledSkillNames).toEqual(['make-pr', 'plan-to-invoker']);
    expect(status.targets[0]?.installed).toBe(false);
  });

  it('installs prefixed skill copies into the Codex skill directory and marks them up to date', () => {
    const resourcesRoot = makeTempRoot('invoker-bundled-resources-');
    const invokerHomeRoot = makeTempRoot('invoker-bundled-home-');
    const repoRoot = makeTempRoot('invoker-bundled-repo-');
    const codexHome = makeTempRoot('invoker-codex-home-');
    const originalHome = process.env.HOME;
    process.env.HOME = codexHome;

    try {
      writeSkill(resourcesRoot, 'plan-to-invoker');
      writeSkill(resourcesRoot, 'make-pr');

      const installed = installBundledSkills({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });

      const codexSkillsRoot = join(codexHome, '.codex', 'skills');
      expect(existsSync(join(codexSkillsRoot, 'invoker-plan-to-invoker', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(codexSkillsRoot, 'invoker-make-pr', 'scripts', 'check.sh'))).toBe(true);
      expect(readFileSync(join(codexSkillsRoot, 'invoker-plan-to-invoker', 'SKILL.md'), 'utf-8')).toContain('plan-to-invoker');

      expect(installed.targets[0]?.installed).toBe(true);
      expect(installed.targets[0]?.upToDate).toBe(true);
      expect(installed.promptRecommended).toBe(false);

      const status = resolveBundledSkillsStatus({
        isPackaged: true,
        repoRoot,
        resourcesPath: resourcesRoot,
        invokerHomeRoot,
      });
      expect(status.targets[0]?.upToDate).toBe(true);
      expect(status.promptRecommended).toBe(false);
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});
