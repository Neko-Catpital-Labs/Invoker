import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const mainSource = readFileSync(join(__dirname, '..', 'main.ts'), 'utf8');

describe('boot-reconcile forced-stop reason in main.ts', () => {
  it('passes OWNER_RESTART_REASON at both boot-reconcile call sites', () => {
    const callSites = mainSource.match(/reconcileOrphanedInFlightTasksOnBoot\(\{[^}]*\}/g) ?? [];
    expect(callSites).toHaveLength(2);
    for (const callSite of callSites) {
      expect(callSite).toContain('reason: OWNER_RESTART_REASON');
    }
  });

  it('keeps the graceful-quit and headless-shutdown Application quit literals unchanged', () => {
    const literalCount = (mainSource.match(/'Application quit'/g) ?? []).length;
    expect(literalCount).toBe(4);
  });
});
