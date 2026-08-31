import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';

const MAIN = path.resolve(__dirname, '..', 'main.ts');

describe('desktop owner worker startup ordering', () => {
  it('starts owner workers before deferred UI startup work can block the event loop', () => {
    const source = readFileSync(MAIN, 'utf8');
    const controllerIdx = source.lastIndexOf('workerRuntimeController = createWorkerRuntimeController({');
    const workerStartIdx = source.indexOf(
      'workerRuntimeController.startAutoStartedWorkers();',
      controllerIdx,
    );
    const deferredMaintenanceIdx = source.indexOf(
      '// Fail orphaned in-flight tasks left by a previous crash, then start ready work.',
      controllerIdx,
    );
    const deferredWorkerStartIdx = source.indexOf(
      'workerRuntimeController?.startAutoStartedWorkers();',
    );

    expect(controllerIdx, 'desktop owner worker controller not found').toBeGreaterThan(-1);
    expect(workerStartIdx, 'desktop owner worker autostart not found after controller construction')
      .toBeGreaterThan(controllerIdx);
    expect(deferredMaintenanceIdx, 'deferred owner startup maintenance not found').toBeGreaterThan(controllerIdx);
    expect(workerStartIdx).toBeLessThan(deferredMaintenanceIdx);
    expect(deferredWorkerStartIdx, 'worker autostart must not remain deferred behind UI startup').toBe(-1);
  });
});
