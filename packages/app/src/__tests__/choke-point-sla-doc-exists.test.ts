import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(__dirname, '..', '..', '..', '..');
const SLA_DOC_PATH = resolve(REPO_ROOT, 'docs/architecture/choke-point-slas.md');

describe('choke-point SLA architecture note', () => {
  it('exists at the committed architecture path with the expected SLA sections', () => {
    expect(existsSync(SLA_DOC_PATH)).toBe(true);

    const body = readFileSync(SLA_DOC_PATH, 'utf8');
    expect(body).toMatch(/^# Choke-Point SLAs$/m);
    expect(body).toMatch(/^## Confirmed Budgets$/m);
    expect(body).toMatch(/^## Completeness Contract$/m);
  });
});
