import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { listBundledSkillNames } from './bundled-skills.js';

const tempRoots: string[] = [];

function makeSourceRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'invoker-skill-selection-'));
  tempRoots.push(root);
  return root;
}

function writeSkill(sourceRoot: string, name: string, category?: string): void {
  const skillDir = join(sourceRoot, name);
  mkdirSync(skillDir, { recursive: true });
  const categoryLine = category ? `category: ${category}\n` : '';
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    `---\nname: ${name}\n${categoryLine}description: test skill\n---\n\n# ${name}\n`,
  );
}

function makeFixtureRoot(): string {
  const sourceRoot = makeSourceRoot();
  writeSkill(sourceRoot, 'alpha-core', 'core');
  writeSkill(sourceRoot, 'beta-optimization', 'optimization');
  writeSkill(sourceRoot, 'delta-core', 'core');
  writeSkill(sourceRoot, 'gamma-untagged');
  return sourceRoot;
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('listBundledSkillNames category selection', () => {
  it('returns every bundled skill when no category is supplied', () => {
    const sourceRoot = makeFixtureRoot();

    expect(listBundledSkillNames(sourceRoot)).toEqual([
      'alpha-core',
      'beta-optimization',
      'delta-core',
      'gamma-untagged',
    ]);
  });

  it('returns the same full set when the default category is passed explicitly', () => {
    const sourceRoot = makeFixtureRoot();

    expect(listBundledSkillNames(sourceRoot, 'all')).toEqual(listBundledSkillNames(sourceRoot));
  });

  it('returns only core skills for the core category', () => {
    const sourceRoot = makeFixtureRoot();

    expect(listBundledSkillNames(sourceRoot, 'core')).toEqual(['alpha-core', 'delta-core']);
  });

  it('returns only optimization skills for the optimization category', () => {
    const sourceRoot = makeFixtureRoot();

    expect(listBundledSkillNames(sourceRoot, 'optimization')).toEqual(['beta-optimization']);
  });

  it('excludes an untagged skill from both named categories but keeps it in the default', () => {
    const sourceRoot = makeSourceRoot();
    writeSkill(sourceRoot, 'untagged-only');

    expect(listBundledSkillNames(sourceRoot)).toEqual(['untagged-only']);
    expect(listBundledSkillNames(sourceRoot, 'core')).toEqual([]);
    expect(listBundledSkillNames(sourceRoot, 'optimization')).toEqual([]);
  });

  it('ignores a category key that appears below the frontmatter block', () => {
    const sourceRoot = makeSourceRoot();
    const skillDir = join(sourceRoot, 'body-mention');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '---\nname: body-mention\n---\n\ncategory: core\n');

    expect(listBundledSkillNames(sourceRoot)).toEqual(['body-mention']);
    expect(listBundledSkillNames(sourceRoot, 'core')).toEqual([]);
  });

  it('skips directories without a SKILL.md regardless of category', () => {
    const sourceRoot = makeFixtureRoot();
    mkdirSync(join(sourceRoot, 'not-a-skill'), { recursive: true });

    expect(listBundledSkillNames(sourceRoot)).not.toContain('not-a-skill');
    expect(listBundledSkillNames(sourceRoot, 'core')).toEqual(['alpha-core', 'delta-core']);
  });
});
