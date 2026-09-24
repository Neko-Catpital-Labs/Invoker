import { describe, expect, it } from 'vitest';

import {
  AGENT_LOGIN_WATCH_WORKER_KIND,
  CATSTACK_DEPLOY_WORKER_KIND,
  createWorkerRuntimeController,
  BUILT_IN_WORKER_KINDS,
} from '../worker-control.js';

describe('agent-login-watch worker control wiring', () => {
  it('is built in and remains off by default', () => {
    expect(BUILT_IN_WORKER_KINDS.has(AGENT_LOGIN_WATCH_WORKER_KIND)).toBe(true);
    expect(BUILT_IN_WORKER_KINDS.has(CATSTACK_DEPLOY_WORKER_KIND)).toBe(true);
  });

  it('does not start a worker when its desired state is off', () => {
    let starts = 0;
    const registry = {
      list: () => [{ kind: AGENT_LOGIN_WATCH_WORKER_KIND, note: 'test', factory: () => ({
        identity: { kind: AGENT_LOGIN_WATCH_WORKER_KIND, instanceId: 'test' },
        isRunning: () => false,
        start: () => { starts += 1; },
        stop: () => undefined,
      }) }],
      get: () => undefined,
    } as never;
    const persistence = {
      getWorkerDesiredState: () => undefined,
    } as never;

    const controller = createWorkerRuntimeController({
      registry,
      deps: { logger: { info: () => undefined, warn: () => undefined, error: () => undefined } } as never,
      autoStartKinds: [],
      persistence,
      canControl: () => true,
    });

    controller.startAutoStartedWorkers();
    expect(starts).toBe(0);
  });
});
