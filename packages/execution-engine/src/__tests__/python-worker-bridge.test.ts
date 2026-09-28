import { describe, expect, it } from 'vitest';

import { loadDecisionFixturesForKind } from '../workers/decision-fixtures/load.js';
import { decideWithPython } from '../workers/python-worker-bridge.js';

describe('python worker bridge', () => {
  it('heartbeat-requeue fixtures match Python decide', () => {
    for (const fixture of loadDecisionFixturesForKind('heartbeat-requeue')) {
      const decisions = decideWithPython(fixture.kind, fixture.state ?? {});
      expect(decisions).toEqual(fixture.decisions);
    }
  });

  it('idle-task-cleanup fixtures match Python decide', () => {
    for (const fixture of loadDecisionFixturesForKind('idle-task-cleanup')) {
      const decisions = decideWithPython(fixture.kind, fixture.state ?? {});
      expect(decisions).toEqual(fixture.decisions);
    }
  });
});
