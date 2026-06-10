import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(path.resolve(__dirname, '..', 'main.ts'), 'utf8');

function getTranslatorSource(): string {
  const start = mainSource.indexOf('function translateGuiMutationToHeadless');
  const end = mainSource.indexOf('  async function performSharedApproveTask', start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return mainSource.slice(start, end);
}

describe('GUI mutation translation', () => {
  it.each([
    'invoker:check-pr-statuses',
    'invoker:check-pr-status',
  ])('routes %s to the owner GUI mutation handler', (channel) => {
    const translatorSource = getTranslatorSource();
    expect(translatorSource).toMatch(
      new RegExp(
        `case '${channel}':\\s*return \\{ channel: 'headless\\.gui-mutation', request: payload \\};`,
      ),
    );
  });
});
