import { describe, expect, it } from 'vitest';

import { assertWorkerToggleHasSingleConfigSource } from '../onboarding-invariants.js';
import {
  applyWorkerToggle,
  findWorkerToggle,
  ONBOARDING_WORKER_TOGGLES,
  readWorkerToggleValue,
} from '../worker-toggles.js';

describe('ONBOARDING_WORKER_TOGGLES', () => {
  it('has a unique id and a real InvokerConfig-backed path for every toggle', () => {
    const ids = ONBOARDING_WORKER_TOGGLES.map((spec) => spec.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const spec of ONBOARDING_WORKER_TOGGLES) {
      // Guards the exact disk-headroom-cleanup regression found this session:
      // a toggle backed by a bare env var instead of a real config field.
      expect(() => assertWorkerToggleHasSingleConfigSource(spec)).not.toThrow();
    }
  });
});

describe('applyWorkerToggle / readWorkerToggleValue', () => {
  it('sets and reads a top-level boolean field', () => {
    const spec = findWorkerToggle('e2e-autofix')!;
    const config = applyWorkerToggle({}, spec, true);
    expect(config).toEqual({ e2eAutoFixEnabled: true });
    expect(readWorkerToggleValue(config, spec)).toBe(true);
  });

  it('sets and reads a nested boolean field, preserving sibling keys', () => {
    const spec = findWorkerToggle('pr-maintenance')!;
    const config = applyWorkerToggle({ prMaintenance: { repoRoot: '/srv/invoker' } }, spec, true);
    expect(config).toEqual({ prMaintenance: { repoRoot: '/srv/invoker', enabled: true } });
    expect(readWorkerToggleValue(config, spec)).toBe(true);
  });

  it('creates the nested object when it does not exist yet', () => {
    const spec = findWorkerToggle('disk-headroom-cleanup')!;
    const config = applyWorkerToggle({}, spec, false);
    expect(config).toEqual({ diskHeadroom: { cleanupEnabled: false } });
  });

  it('returns undefined for an unset toggle, not a false default', () => {
    const spec = findWorkerToggle('auto-approve')!;
    expect(readWorkerToggleValue({}, spec)).toBeUndefined();
  });

  it('does not mutate the input config object', () => {
    const spec = findWorkerToggle('e2e-autofix')!;
    const original = { defaultBranch: 'main' };
    const updated = applyWorkerToggle(original, spec, true);
    expect(original).toEqual({ defaultBranch: 'main' });
    expect(updated).not.toBe(original);
  });
});
