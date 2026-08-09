import { spawnSync } from 'node:child_process';

export function commandExists(command: string): boolean {
  return spawnSync(
    'sh',
    ['-c', 'command -v "$1" >/dev/null 2>&1', 'sh', command],
    { stdio: 'ignore' },
  ).status === 0;
}
