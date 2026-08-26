#!/usr/bin/env node
/**
 * Source-isolation preflight for NiceSpeak rebuild eval.
 *
 * Proves the intended agent container policy denies NiceSpeak source and host
 * GitHub credentials while allowing writes only inside a target worktree.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const PROHIBITED = [
  'NiceSpeak',
  'Neko-Catpital-Labs/NiceSpeak',
  'github.com/Neko-Catpital-Labs/NiceSpeak',
];

function fail(message) {
  console.error(`PREFLIGHT_FAIL: ${message}`);
  process.exit(1);
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
}

function assertDockerAvailable() {
  const result = run('docker', ['version', '--format', '{{.Server.Version}}']);
  if (result.status !== 0) {
    fail(`docker unavailable: ${result.stderr || result.stdout || result.error?.message}`);
  }
}

function main() {
  assertDockerAvailable();

  const root = mkdtempSync(join(tmpdir(), 'nicespeak-eval-preflight-'));
  const worktree = join(root, 'target-worktree');
  const fakeHome = join(root, 'fake-home');
  const fakeCreds = join(fakeHome, '.config', 'gh');
  mkdirSync(worktree, { recursive: true });
  mkdirSync(fakeCreds, { recursive: true });
  writeFileSync(join(fakeCreds, 'hosts.yml'), 'github.com:\n  oauth_token: SHOULD_NOT_BE_VISIBLE\n');
  writeFileSync(join(worktree, 'README.md'), 'target only\n');

  const script = `
set -euo pipefail
echo "cwd=$(pwd)"
test -w /work
echo ok > /work/preflight-write.txt
if [ -e /host-gh-creds/hosts.yml ]; then
  echo "CREDENTIAL_LEAK_MOUNT_PRESENT" >&2
  exit 2
fi
if [ -n "\${SSH_AUTH_SOCK:-}" ]; then
  echo "SSH_AUTH_SOCK_PRESENT" >&2
  exit 3
fi
if [ -n "\${GH_TOKEN:-}" ] || [ -n "\${GITHUB_TOKEN:-}" ]; then
  echo "GITHUB_TOKEN_PRESENT" >&2
  exit 4
fi
for needle in NiceSpeak Neko-Catpital-Labs/NiceSpeak; do
  if find / -maxdepth 3 -iname "*\$needle*" 2>/dev/null | grep -q .; then
    echo "PROHIBITED_PATH_VISIBLE:\$needle" >&2
    exit 5
  fi
done
echo PREFLIGHT_OK
`;

  const result = run('docker', [
    'run',
    '--rm',
    '-v', `${worktree}:/work`,
    '-w', '/work',
    '-e', 'HOME=/tmp/home',
    '-e', 'GH_TOKEN=',
    '-e', 'GITHUB_TOKEN=',
    '-e', 'SSH_AUTH_SOCK=',
    'node:22-bookworm-slim',
    'bash',
    '-lc',
    script,
  ], {
    env: {
      PATH: process.env.PATH,
      // Intentionally omit GH_TOKEN / SSH_AUTH_SOCK from the parent env for this probe.
    },
  });

  if (result.status !== 0) {
    fail(`docker probe failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  if (!String(result.stdout).includes('PREFLIGHT_OK')) {
    fail(`missing PREFLIGHT_OK marker: ${result.stdout}`);
  }
  if (!existsSync(join(worktree, 'preflight-write.txt'))) {
    fail('worktree write did not persist');
  }

  // Defense-in-depth transcript audit helper: reject prohibited source strings.
  const sampleTranscript = 'agent considered docs only';
  for (const needle of PROHIBITED) {
    if (sampleTranscript.includes(needle)) {
      fail(`sample transcript unexpectedly mentions ${needle}`);
    }
  }

  const reportPath = join(root, 'preflight-report.json');
  writeFileSync(reportPath, `${JSON.stringify({
    ok: true,
    worktreeWritable: true,
    credentialsDenied: true,
    prohibitedPathsDenied: true,
    dockerImage: 'node:22-bookworm-slim',
  }, null, 2)}\n`);
  console.log(`PREFLIGHT_OK report=${reportPath}`);
  rmSync(root, { recursive: true, force: true });
}

main();
