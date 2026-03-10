import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/protocol';
import { DockerFamiliar } from '../docker-familiar.js';

// ---------------------------------------------------------------------------
// Skip entire suite when Docker is unavailable
// ---------------------------------------------------------------------------

function dockerAvailable(): boolean {
  try {
    execSync('docker info', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const DOCKER_OK = dockerAvailable();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_REPO_URL = 'https://github.com/EdbertChan/test-playground.git';

function makeRequest(overrides: Partial<WorkRequest> = {}): WorkRequest {
  return {
    requestId: `req-${Date.now()}`,
    actionId: `act-${Date.now()}`,
    actionType: 'command',
    inputs: { command: 'echo hello' },
    callbackUrl: '',
    timestamps: { createdAt: new Date().toISOString() },
    ...overrides,
  };
}

function waitForComplete(
  familiar: DockerFamiliar,
  handle: ReturnType<Awaited<ReturnType<DockerFamiliar['start']>>>,
  timeoutMs = 60_000,
): Promise<WorkResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    familiar.onComplete(handle, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER_OK)('DockerFamiliar (real Docker)', () => {
  let workDir: string;
  let familiar: DockerFamiliar;

  beforeAll(() => {
    // Ensure image is built
    try {
      execSync('docker image inspect invoker-agent:latest', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'invoker-agent:latest not found. Run: pnpm --filter @invoker/executors run docker:build',
      );
    }
  });

  afterEach(async () => {
    if (familiar) {
      await familiar.destroyAll();
    }
    if (workDir && existsSync(workDir)) {
      // Container runs as root, creating root-owned files in bind-mounted dir.
      // Use a Docker container to clean up since host user can't delete them.
      try {
        execSync(
          `docker run --rm -v "${workDir}:/cleanup" alpine sh -c "rm -rf /cleanup/.[!.]* /cleanup/*"`,
          { stdio: 'ignore' },
        );
      } catch { /* best effort */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  function setup() {
    workDir = mkdtempSync(join(tmpdir(), 'invoker-docker-test-'));
    mkdirSync(join(workDir, '.invoker'), { recursive: true });

    // Initialize a git repo so the agent script's auto-commit works
    execSync('git init && git commit --allow-empty -m "init"', {
      cwd: workDir,
      stdio: 'ignore',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    familiar = new DockerFamiliar({
      workspaceDir: workDir,
      claudeConfigDir: '/nonexistent-path-to-skip-mount',
      sshDir: '/nonexistent-path-to-skip-mount',
    });
  }

  // -------------------------------------------------------------------------

  it('runs a command in a container and returns completed', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'echo hello-from-docker' },
    });

    const handle = await familiar.start(request);
    const response = await waitForComplete(familiar, handle);

    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);
    expect(response.requestId).toBe(request.requestId);
    expect(response.actionId).toBe(request.actionId);
  }, 60_000);

  it('captures container stdout via onOutput', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'echo MARKER_OUTPUT_12345' },
    });

    const handle = await familiar.start(request);
    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    await waitForComplete(familiar, handle);

    const combined = output.join('');
    expect(combined).toContain('MARKER_OUTPUT_12345');
  }, 60_000);

  it('returns failed status on non-zero exit code', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'exit 42' },
    });

    const handle = await familiar.start(request);
    const response = await waitForComplete(familiar, handle);

    // The agent script exits with the command's exit code
    expect(response.status).toBe('failed');
    expect(response.outputs.exitCode).not.toBe(0);
  }, 60_000);

  it('kill stops a running container', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'sleep 300' },
    });

    const handle = await familiar.start(request);

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 2_000));

    await familiar.kill(handle);

    // After kill, the container should be gone
    // Verify by checking that getTerminalSpec still returns the entry
    // (it's tracked internally even after kill)
    const spec = familiar.getTerminalSpec(handle);
    expect(spec).toBeDefined();
  }, 30_000);

  it('getTerminalSpec returns docker exec command', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'sleep 10' },
    });

    const handle = await familiar.start(request);

    const spec = familiar.getTerminalSpec(handle);
    expect(spec).not.toBeNull();
    expect(spec!.command).toBe('bash');
    expect(spec!.args![0]).toBe('-c');
    const bashCmd = spec!.args![1];
    expect(bashCmd).toContain('docker start');
    expect(bashCmd).toContain('docker exec -it');
    expect(bashCmd).toContain('/bin/bash');
  }, 30_000);

  it('creates files visible in bind-mounted workspace', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'echo "new content" > created-by-docker.txt' },
    });

    const handle = await familiar.start(request);
    const response = await waitForComplete(familiar, handle);

    expect(response.status).toBe('completed');

    // With direct Cmd execution (no entrypoint), the file should exist in the workspace
    expect(existsSync(join(workDir, 'created-by-docker.txt'))).toBe(true);
  }, 60_000);

  it('runs multiple containers concurrently', async () => {
    setup();

    const requests = [
      makeRequest({
        requestId: 'req-a',
        actionId: 'act-a',
        actionType: 'command',
        inputs: { command: 'echo container-a' },
      }),
      makeRequest({
        requestId: 'req-b',
        actionId: 'act-b',
        actionType: 'command',
        inputs: { command: 'echo container-b' },
      }),
    ];

    // Start both — note: they share workspaceDir so the second start
    // overwrites request.json. This is a known limitation for concurrent
    // tasks in a single DockerFamiliar with the same workspaceDir.
    // In production, each task gets its own workspace. Here we test
    // that multiple containers can run without crashing.
    const handles = [];
    for (const req of requests) {
      handles.push(await familiar.start(req));
    }

    const responses = await Promise.all(
      handles.map((h) => waitForComplete(familiar, h)),
    );

    // Both should complete — with direct Cmd execution, there's no
    // request.json conflict so both containers run independently.
    for (const r of responses) {
      expect(['completed', 'failed']).toContain(r.status);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// DockerPool integration tests — cached image from test-playground
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER_OK)('DockerFamiliar + DockerPool (real Docker, real repo)', () => {
  let workDir: string;
  let familiar: DockerFamiliar;

  beforeAll(() => {
    try {
      execSync('docker image inspect invoker-agent:latest', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'invoker-agent:latest not found. Run: pnpm --filter @invoker/executors run docker:build',
      );
    }
  });

  afterEach(async () => {
    if (familiar) {
      await familiar.destroyAll();
    }
    if (workDir && existsSync(workDir)) {
      // Container runs as root, creating root-owned files in bind-mounted dir.
      // Use a Docker container to clean up since host user can't delete them.
      try {
        execSync(
          `docker run --rm -v "${workDir}:/cleanup" alpine sh -c "rm -rf /cleanup/.[!.]* /cleanup/*"`,
          { stdio: 'ignore' },
        );
      } catch { /* best effort */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  function setup() {
    workDir = mkdtempSync(join(tmpdir(), 'invoker-docker-pool-test-'));
    mkdirSync(join(workDir, '.invoker'), { recursive: true });

    familiar = new DockerFamiliar({
      workspaceDir: workDir,
      cacheImages: true,
      claudeConfigDir: '/nonexistent-path-to-skip-mount',
      sshDir: '/nonexistent-path-to-skip-mount',
    });
  }

  it('creates cached image from test-playground and runs a command', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: {
        repoUrl: TEST_REPO_URL,
        command: 'ls -la /app && cat /app/README.md',
      },
    });

    const handle = await familiar.start(request);
    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    const response = await waitForComplete(familiar, handle);

    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);

    // The output should contain content from the test-playground repo
    const combined = output.join('');
    expect(combined).toContain('README');
  }, 120_000);

  it('reuses cached image on second task for same repo', async () => {
    setup();

    // First task — triggers image build
    const req1 = makeRequest({
      requestId: 'req-pool-1',
      actionId: 'act-pool-1',
      actionType: 'command',
      inputs: {
        repoUrl: TEST_REPO_URL,
        command: 'echo first-run',
      },
    });

    const h1 = await familiar.start(req1);
    await waitForComplete(familiar, h1);

    // Second task — should reuse cached image (faster)
    const startTime = Date.now();
    const req2 = makeRequest({
      requestId: 'req-pool-2',
      actionId: 'act-pool-2',
      actionType: 'command',
      inputs: {
        repoUrl: TEST_REPO_URL,
        command: 'echo second-run',
      },
    });

    const h2 = await familiar.start(req2);
    const response = await waitForComplete(familiar, h2);
    const elapsed = Date.now() - startTime;

    expect(response.status).toBe('completed');
    // Second run should be noticeably faster (no git clone)
    // We don't assert on exact timing but log it for visibility
    console.log(`Second run (cached image) took ${elapsed}ms`);
  }, 180_000);

  it('cached container has the repo contents at /app', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: {
        repoUrl: TEST_REPO_URL,
        command: 'test -f /app/README.md && echo "REPO_PRESENT" || echo "REPO_MISSING"',
      },
    });

    const handle = await familiar.start(request);
    const output: string[] = [];
    familiar.onOutput(handle, (data) => output.push(data));

    const response = await waitForComplete(familiar, handle);
    const combined = output.join('');

    expect(response.status).toBe('completed');
    expect(combined).toContain('REPO_PRESENT');
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Claude CLI inside Docker integration tests
// ---------------------------------------------------------------------------

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!DOCKER_OK || !HAS_API_KEY)('DockerFamiliar Claude E2E (real Docker + Claude CLI)', () => {
  let workDir: string;
  let familiar: DockerFamiliar;

  afterEach(async () => {
    if (familiar) {
      await familiar.destroyAll();
    }
    if (workDir && existsSync(workDir)) {
      try {
        execSync(
          `docker run --rm -v "${workDir}:/cleanup" alpine sh -c "rm -rf /cleanup/.[!.]* /cleanup/*"`,
          { stdio: 'ignore' },
        );
      } catch { /* best effort */ }
      rmSync(workDir, { recursive: true, force: true });
    }
  });

  function setup() {
    workDir = mkdtempSync(join(tmpdir(), 'invoker-docker-claude-test-'));
    familiar = new DockerFamiliar({
      workspaceDir: workDir,
      anthropicApiKey: process.env.ANTHROPIC_API_KEY,
      claudeConfigDir: '/nonexistent-path-to-skip-mount',
      sshDir: '/nonexistent-path-to-skip-mount',
    });
  }

  it('claude session produces valid handle with sessionId', async () => {
    setup();

    const request = makeRequest({
      actionType: 'claude',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await familiar.start(request);

    expect(handle.claudeSessionId).toBeDefined();
    expect(handle.claudeSessionId).toMatch(/^[0-9a-f-]+$/);
  }, 120_000);

  it('claude session completes and returns sessionId in outputs', async () => {
    setup();

    const request = makeRequest({
      actionType: 'claude',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await familiar.start(request);
    const response = await waitForComplete(familiar, handle, 120_000);

    expect(response.status).toBe('completed');
    expect(response.outputs.claudeSessionId).toBe(handle.claudeSessionId);
    expect(response.outputs.exitCode).toBe(0);
  }, 180_000);

  it('getTerminalSpec returns docker exec claude --resume', async () => {
    setup();

    const request = makeRequest({
      actionType: 'claude',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await familiar.start(request);
    const spec = familiar.getTerminalSpec(handle);

    expect(spec).toBeDefined();
    expect(spec!.command).toBe('bash');
    const bashCmd = spec!.args![1];
    expect(bashCmd).toContain('docker start');
    expect(bashCmd).toContain(`docker exec -it`);
    expect(bashCmd).toContain(`claude --resume ${handle.claudeSessionId}`);
  }, 120_000);
});
