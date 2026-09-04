import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const GUI_MUTATION_HANDLERS = path.resolve(__dirname, '..', 'ipc', 'gui-mutation-handlers.ts');

describe('repair-review-gate-ci delegated wiring', () => {
  it('constructs repairReviewGateCi inside executeHeadlessExec so delegated headless.exec can reach it', () => {
    const source = readFileSync(GUI_MUTATION_HANDLERS, 'utf8');
    const fnStart = source.indexOf('async function executeHeadlessExec(');
    const fnEnd = source.indexOf('\n  }\n', fnStart);
    expect(fnStart, 'executeHeadlessExec not found').toBeGreaterThan(-1);
    expect(fnEnd, 'executeHeadlessExec body end not found').toBeGreaterThan(fnStart);

    const body = source.slice(fnStart, fnEnd);
    expect(body).toContain('repairReviewGateCi:');
    expect(body).toContain('repairReviewGateCiByPr(');
    expect(body).toContain('submitRegisteredOwnerWorkerMutation && autoFixAttemptLedger');
  });
});
