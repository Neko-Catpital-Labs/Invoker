import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
const skillsRoot = join(repoRoot, 'skills');

function bundledSkillNames(): string[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(skillsRoot, entry.name, 'SKILL.md')))
    .map((entry) => entry.name)
    .sort();
}

// Guards against the class of corruption behind #5231: a botched stacked-PR
// conflict resolution gutted skills/plan-to-invoker/SKILL.md into a raw `git show`
// blob (no frontmatter, `commit <sha>` + `diff --git` text), which every agent
// runtime rejects with "missing YAML frontmatter". This test fails in repo CI the
// moment any bundled SKILL.md loses its frontmatter or becomes a git artifact,
// before the installer can mirror it into an agent's global skill store.
describe('bundled skill SKILL.md integrity', () => {
  const names = bundledSkillNames();

  it('finds bundled skills to check', () => {
    expect(names.length).toBeGreaterThan(0);
  });

  it.each(names)('skills/%s/SKILL.md opens with a YAML frontmatter block', (name) => {
    const content = readFileSync(join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const lines = content.split('\n');

    expect(lines[0]?.trim(), `${name}/SKILL.md must start with '---'`).toBe('---');
    expect(
      lines.slice(1).some((line) => line.trim() === '---'),
      `${name}/SKILL.md must close its frontmatter with '---'`,
    ).toBe(true);
    expect(content, `${name}/SKILL.md must not contain a raw git diff header`).not.toContain('diff --git ');
    expect(content, `${name}/SKILL.md must not contain merge conflict markers`).not.toMatch(/^(?:<{7}|={7}|>{7})/m);
    expect(content, `${name}/SKILL.md must not be a raw git-show blob`).not.toMatch(/^commit [0-9a-f]{40}$/m);
  });
});
