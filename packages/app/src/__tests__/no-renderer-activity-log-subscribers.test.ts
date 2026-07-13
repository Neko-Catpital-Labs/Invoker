import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as fs from 'node:fs';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const UI_SRC = path.join(REPO_ROOT, 'packages', 'ui', 'src');

function walk(dir: string): string[] {
  const out: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__' || entry.name === 'node_modules' || entry.name === 'dist') {
        continue;
      }
      out.push(...walk(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe('invoker:activity-log IPC channel', () => {
  it('has no renderer subscribers under packages/ui/src (excluding tests)', () => {
    const files = walk(UI_SRC);
    const matches: Array<{ file: string; line: number; text: string }> = [];
    for (const file of files) {
      const contents = readFileSync(file, 'utf8');
      const lines = contents.split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        if (/onActivityLog\s*\(/.test(line) || /['"]invoker:activity-log['"]/.test(line)) {
          matches.push({ file: path.relative(REPO_ROOT, file), line: i + 1, text: line.trim() });
        }
      }
    }
    if (matches.length > 0) {
      const summary = matches
        .map((m) => `  ${m.file}:${m.line}  ${m.text}`)
        .join('\n');
      throw new Error(
        `Unexpected renderer subscribers for invoker:activity-log found:\n${summary}\n\n` +
          'If you are adding a legitimate subscriber, re-enable the main-process ' +
          '`invoker:activity-log` poll in packages/app/src/main.ts (removed to avoid dead work) ' +
          'and update this test.',
      );
    }
    expect(matches).toEqual([]);
  });
});
