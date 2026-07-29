import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import * as path from 'node:path';
import { test, expect, type TestInfo } from '@playwright/test';
import { resolveRepoRoot } from '@invoker/contracts';
import { E2E_BARE_REPO } from './global-setup.js';

const repoRoot = resolveRepoRoot(__dirname);

test.describe.configure({ mode: 'serial' });

test.describe('backend and renderer task graph timelines', () => {
  test('stay in sync through rebase-recreate', async ({}, testInfo) => {
    test.setTimeout(300_000);

    const result = await runTimelineRepro();
    await testInfo.attach('ui-delta-timeline-stdout', {
      body: result.stdout,
      contentType: 'text/plain',
    });
    await testInfo.attach('ui-delta-timeline-stderr', {
      body: result.stderr,
      contentType: 'text/plain',
    });

    if (result.code !== 0) {
      await attachFailureArtifacts(testInfo, result.stderr);
    }

    expect(result.code, lastLines(result.stderr || result.stdout)).toBe(0);
  });
});

async function runTimelineRepro(): Promise<{
  code: number | null;
  stdout: string;
  stderr: string;
}> {
  return await new Promise((resolve, reject) => {
    const child = spawn('bash', ['scripts/repro/repro-ui-delta-timeline.sh'], {
      cwd: repoRoot,
      env: {
        ...process.env,
        INVOKER_UI_DELTA_REPO_URL: pathToFileURL(E2E_BARE_REPO).href,
        INVOKER_UI_DELTA_TMPDIR: '/tmp',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code) => {
      resolve({ code, stdout, stderr });
    });
  });
}

async function attachFailureArtifacts(
  testInfo: TestInfo,
  stderr: string,
): Promise<void> {
  const artifactsDir = stderr.match(/^Artifacts: (.+)$/m)?.[1]?.trim();
  if (!artifactsDir || !existsSync(artifactsDir)) return;

  for (const file of ['comparison.json', 'backend.raw.log', 'renderer.raw.jsonl']) {
    const filePath = path.join(artifactsDir, file);
    if (!existsSync(filePath)) continue;
    await testInfo.attach(file, {
      body: await readFile(filePath, 'utf8'),
      contentType: file.endsWith('.json') || file.endsWith('.jsonl')
        ? 'application/json'
        : 'text/plain',
    });
  }
}

function lastLines(value: string, count = 80): string {
  return value.split(/\r?\n/).slice(-count).join('\n');
}
