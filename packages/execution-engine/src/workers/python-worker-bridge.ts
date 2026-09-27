import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { WorkerDecision } from './decision-fixtures/types.js';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../../invoker_worker');
const CLI = join(PACKAGE_ROOT, 'invoker_worker', 'cli.py');

export function decideWithPython(kind: string, state: unknown): WorkerDecision[] {
  const result = spawnSync(
    process.env.INVOKER_PYTHON ?? 'python3',
    [CLI],
    {
      input: JSON.stringify({ kind, state }),
      encoding: 'utf8',
      cwd: PACKAGE_ROOT,
      env: {
        ...process.env,
        PYTHONPATH: PACKAGE_ROOT,
      },
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `python worker ${kind} failed (status ${result.status}): ${result.stderr || result.stdout}`,
    );
  }
  const parsed = JSON.parse(result.stdout) as { decisions?: WorkerDecision[]; error?: string };
  if (parsed.error) {
    throw new Error(parsed.error);
  }
  if (!Array.isArray(parsed.decisions)) {
    throw new Error(`python worker ${kind} returned no decisions`);
  }
  return parsed.decisions;
}
