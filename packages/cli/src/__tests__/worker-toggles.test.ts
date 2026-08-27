import { describe, expect, it } from 'vitest';

import { assertWorkerToggleHasSingleSource } from '../onboarding-invariants.js';
import {
  applyDesiredStateWorkerToggle,
  applyWorkerToggle,
  findWorkerToggle,
  isDesiredStateWorkerToggle,
  isPolicyWorkerToggle,
  ONBOARDING_WORKER_TOGGLES,
  PR_MAINTENANCE_TOGGLE_WORKER_KINDS,
  WORKER_TOGGLES,
  readDesiredStateWorkerToggleValue,
  readWorkerToggleValue,
} from '../worker-toggles.js';

describe('ONBOARDING_WORKER_TOGGLES', () => {
  it('has a unique id and exactly one of workerKinds or configPath for every toggle', () => {
    const ids = ONBOARDING_WORKER_TOGGLES.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of ONBOARDING_WORKER_TOGGLES) {
      expect(() => assertWorkerToggleHasSingleSource(spec)).not.toThrow();
    }
  });

  it('maps pr-maintenance to the four babysitting worker kinds', () => {
    const spec = findWorkerToggle('pr-maintenance')!;
    expect(isDesiredStateWorkerToggle(spec)).toBe(true);
    expect(spec.workerKinds).toEqual([...PR_MAINTENANCE_TOGGLE_WORKER_KINDS]);
  });

  it('exposes pr-status and autofix as desired-state toggles for CLI', () => {
    const prStatus = findWorkerToggle('pr-status')!;
    const autofix = findWorkerToggle('autofix')!;
    expect(isDesiredStateWorkerToggle(prStatus)).toBe(true);
    expect(isDesiredStateWorkerToggle(autofix)).toBe(true);
    expect(prStatus.workerKinds).toEqual(['pr-status']);
    expect(autofix.workerKinds).toEqual(['autofix']);
    expect(ONBOARDING_WORKER_TOGGLES.some((spec) => spec.id === 'pr-status')).toBe(false);
    expect(ONBOARDING_WORKER_TOGGLES.some((spec) => spec.id === 'autofix')).toBe(false);
    expect(WORKER_TOGGLES.some((spec) => spec.id === 'pr-status')).toBe(true);
  });
});

describe('policy applyWorkerToggle / readWorkerToggleValue', () => {
  it('sets and reads a top-level policy field', () => {
    const spec = findWorkerToggle('auto-approve')!;
    const policyConfig = applyWorkerToggle({}, spec, true);
    expect(policyConfig).toEqual({ autoApproveAIFixes: true });
    expect(readWorkerToggleValue(policyConfig, spec)).toBe(true);
  });

  it('sets and reads a nested policy field, preserving sibling keys', () => {
    const spec = findWorkerToggle('disk-headroom-cleanup')!;
    const nestedPolicyConfig = applyWorkerToggle({ diskHeadroom: { other: 1 } } as never, spec, false);
    expect(nestedPolicyConfig).toEqual({ diskHeadroom: { other: 1, cleanupEnabled: false } });
    expect(readWorkerToggleValue(nestedPolicyConfig, spec)).toBe(false);
  });

  it('returns undefined for an unset policy toggle, not a false default', () => {
    const spec = findWorkerToggle('auto-approve')!;
    expect(readWorkerToggleValue({}, spec)).toBeUndefined();
  });

  it('auto-approve toggle names config.json autoApproveAuthors', () => {
    const spec = findWorkerToggle('auto-approve')!;
    expect(spec.description).toContain('autoApproveAuthors');
  });

  it('rejects applying a desired-state toggle through applyWorkerToggle', () => {
    const spec = findWorkerToggle('pr-maintenance')!;
    expect(() => applyWorkerToggle({}, spec, true)).toThrow(/desired state/);
  });

  it('does not mutate the input config object', () => {
    const spec = findWorkerToggle('auto-approve')!;
    const original = { defaultBranch: 'main' };
    const updated = applyWorkerToggle(original, spec, true);
    expect(original).toEqual({ defaultBranch: 'main' });
    expect(updated).not.toBe(original);
  });
});

describe('desired-state worker toggles', () => {
  function memoryStore(initial: Record<string, boolean> = {}) {
    const desired = new Map(Object.entries(initial));
    return {
      getWorkerDesiredState: (workerKind: string) => (
        desired.has(workerKind)
          ? { desiredEnabled: desired.get(workerKind) === true }
          : undefined
      ),
      setWorkerDesiredState: (workerKind: string, desiredEnabled: boolean) => {
        desired.set(workerKind, desiredEnabled);
        return { workerKind, desiredEnabled };
      },
      desired,
    };
  }

  it('writes every mapped worker kind for pr-maintenance', () => {
    const store = memoryStore();
    const spec = findWorkerToggle('pr-maintenance')!;
    expect(isDesiredStateWorkerToggle(spec)).toBe(true);
    applyDesiredStateWorkerToggle(store, spec, true);
    expect([...store.desired.entries()].sort()).toEqual(
      PR_MAINTENANCE_TOGGLE_WORKER_KINDS.map((kind) => [kind, true]).sort(),
    );
  });

  it('reads true only when every mapped kind is desired-enabled', () => {
    const spec = findWorkerToggle('pr-maintenance')!;
    expect(isDesiredStateWorkerToggle(spec)).toBe(true);
    const partial = memoryStore({ [PR_MAINTENANCE_TOGGLE_WORKER_KINDS[0]]: true });
    expect(readDesiredStateWorkerToggleValue(partial, spec)).toBeUndefined();

    const store = memoryStore();
    applyDesiredStateWorkerToggle(store, spec, true);
    expect(readDesiredStateWorkerToggleValue(store, spec)).toBe(true);
    applyDesiredStateWorkerToggle(store, spec, false);
    expect(readDesiredStateWorkerToggleValue(store, spec)).toBe(false);
  });

  it('returns undefined for a missing row even after an earlier disabled row', () => {
    const spec = findWorkerToggle('pr-maintenance')!;
    const partialWithEarlyDisabled = memoryStore({
      [PR_MAINTENANCE_TOGGLE_WORKER_KINDS[0]]: false,
    });
    expect(readDesiredStateWorkerToggleValue(partialWithEarlyDisabled, spec)).toBeUndefined();
  });

  it('policy toggles are not desired-state toggles', () => {
    expect(isPolicyWorkerToggle(findWorkerToggle('auto-approve')!)).toBe(true);
    expect(isDesiredStateWorkerToggle(findWorkerToggle('auto-approve')!)).toBe(false);
  });
});
