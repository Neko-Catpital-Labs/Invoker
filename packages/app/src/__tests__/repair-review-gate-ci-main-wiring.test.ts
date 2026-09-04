import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

describe('repair-review-gate-ci main.ts wiring', () => {
  it('passes submitRegisteredOwnerWorkerMutation and autoFixAttemptLedger at every createGuiMutationTaskActions and registerGuiMutationIpcHandlers call site', () => {
    const source = readFileSync(MAIN, 'utf8');
    const callSitePatterns = ['createGuiMutationTaskActions({', 'registerGuiMutationIpcHandlers({'];
    const callSiteStarts: number[] = [];
    for (const pattern of callSitePatterns) {
      let fromIndex = 0;
      for (;;) {
        const idx = source.indexOf(pattern, fromIndex);
        if (idx === -1) break;
        callSiteStarts.push(idx);
        fromIndex = idx + pattern.length;
      }
    }
    expect(callSiteStarts.length, 'expected at least one call site').toBeGreaterThan(0);

    for (const start of callSiteStarts) {
      const closeIdx = source.indexOf('\n    });', start);
      const call = source.slice(start, closeIdx > start ? closeIdx : start + 2000);
      expect(call, `call site at offset ${start} missing submitRegisteredOwnerWorkerMutation`).toContain('submitRegisteredOwnerWorkerMutation');
      expect(call, `call site at offset ${start} missing autoFixAttemptLedger`).toContain('autoFixAttemptLedger');
    }
  });
});
