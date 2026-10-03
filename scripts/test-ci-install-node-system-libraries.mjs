#!/usr/bin/env node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function writeExecutable(path, source) {
  writeFileSync(path, source, { mode: 0o755 });
}

const tempDir = mkdtempSync(join(tmpdir(), 'invoker-ci-install-repro-'));
const binDir = join(tempDir, 'bin');
mkdirSync(binDir);

const attemptsPath = join(tempDir, 'apt-attempts.log');

writeExecutable(join(binDir, 'id'), `#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo 0
  exit 0
fi
exec /usr/bin/id "$@"
`);

writeExecutable(join(binDir, 'apt-get'), `#!/usr/bin/env bash
echo "$*" >> "${attemptsPath}"
if [ "$1" = "update" ] && [ ! -f "${tempDir}/failed-once" ]; then
  touch "${tempDir}/failed-once"
  echo "E: Could not get lock /var/lib/dpkg/lock-frontend. It is held by process 1789 (unattended-upgr)" >&2
  echo "E: Unable to acquire the dpkg frontend lock (/var/lib/dpkg/lock-frontend), is another process using it?" >&2
  exit 100
fi
exit 0
`);

const result = spawnSync('bash', ['scripts/ci/install-node-system-libraries.sh'], {
  encoding: 'utf8',
  env: {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    CI_INSTALL_PACKAGES: 'libatomic1',
    CI_INSTALL_PROBE_COMMANDS: 'definitely-missing-ci-tool',
    CI_INSTALL_APT_LOCK_RETRY_ATTEMPTS: '2',
    CI_INSTALL_APT_LOCK_RETRY_SLEEP_SECONDS: '0',
  },
});

assert(
  result.status === 0,
  `installer should retry a transient dpkg lock and continue, got ${result.status}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`,
);

const attempts = readFileSync(attemptsPath, 'utf8').trim().split('\n');
assert(
  attempts.filter((line) => line === 'update').length === 2,
  `installer should retry apt-get update once after the lock failure, got attempts:\n${attempts.join('\n')}`,
);
assert(
  attempts.includes('install -y libatomic1'),
  `installer should continue to apt-get install after the retry succeeds, got attempts:\n${attempts.join('\n')}`,
);

console.log('ok - install-node-system-libraries retries transient dpkg locks');
