import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { acquireSlackConsumerLock, SlackConsumerLockHeldError } from '../slack-consumer-lock.js';

describe('Slack consumer lock', () => {
  it('refuses a second live Socket Mode owner and releases cleanly', () => {
    const home = mkdtempSync(join(tmpdir(), 'invoker-slack-lock-'));
    const first = acquireSlackConsumerLock(home, 'first', process.pid);

    expect(() => acquireSlackConsumerLock(home, 'second', process.pid)).toThrow(SlackConsumerLockHeldError);

    first.release();
    const second = acquireSlackConsumerLock(home, 'second', process.pid);
    expect(second.record.instanceId).toBe('second');
    second.release();
  });
});
