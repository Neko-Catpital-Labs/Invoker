import { execFileSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

const buildPayload = (): string => JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({
  id: `wf-${i}`,
  description: `synthetic workflow row ${i} padded-padded-padded-padded-padded-padded-padded-padded`,
  status: 'completed',
})));

const script = `
const payload = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({
  id: 'wf-' + i,
  description: 'synthetic workflow row ' + i + ' padded-padded-padded-padded-padded-padded-padded-padded',
  status: 'completed',
})));
process.stdout.write(payload, () => { process.exitCode = 0; });
`;

describe('headless stdout flush', () => {
  it('preserves large JSON stdout when the child waits for the write callback', () => {
    const payload = buildPayload();
    expect(payload.length).toBeGreaterThanOrEqual(250 * 1024);

    for (let trial = 0; trial < 5; trial += 1) {
      const output = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' });
      expect(output.length).toBe(payload.length);
      expect(() => JSON.parse(output)).not.toThrow();
    }
  });
});
