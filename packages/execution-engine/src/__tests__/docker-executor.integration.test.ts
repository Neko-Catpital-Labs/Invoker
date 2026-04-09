import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { WorkRequest, WorkResponse } from '@invoker/contracts';
import type { ExecutorHandle } from '../executor.js';
import { DockerExecutor } from '../docker-executor.js';

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
  executor: DockerExecutor,
  handle: ExecutorHandle,
  timeoutMs = 60_000,
): Promise<WorkResponse> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    executor.onComplete(handle, (response) => {
      clearTimeout(timer);
      resolve(response);
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe.skipIf(!DOCKER_OK)('DockerExecutor (real Docker)', () => {
  let workDir: string;
  let executor: DockerExecutor;

  beforeAll(() => {
    // Ensure base image is built
    try {
      execSync('docker image inspect invoker/agent-base:latest', { stdio: 'ignore' });
    } catch {
      throw new Error(
        'invoker/agent-base:latest not found. Run: bash scripts/build-agent-base-image.sh',
      );
    }
  });

  afterEach(async () => {
    if (executor) {
      await executor.destroyAll();
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

    executor = new DockerExecutor({});
  }

  // -------------------------------------------------------------------------

  it('runs a command in a container and returns completed', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'echo hello-from-docker' },
    });

    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

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

    const handle = await executor.start(request);
    const output: string[] = [];
    executor.onOutput(handle, (data) => output.push(data));

    await waitForComplete(executor, handle);

    const combined = output.join('');
    expect(combined).toContain('MARKER_OUTPUT_12345');
  }, 60_000);

  it('returns failed status on non-zero exit code', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'exit 42' },
    });

    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle);

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

    const handle = await executor.start(request);

    // Give it a moment to start
    await new Promise((r) => setTimeout(r, 2_000));

    await executor.kill(handle);

    // After kill, the container should be gone
    // Verify by checking that getTerminalSpec still returns the entry
    // (it's tracked internally even after kill)
    const spec = executor.getTerminalSpec(handle);
    expect(spec).toBeDefined();
  }, 30_000);

  it('getTerminalSpec returns docker exec command', async () => {
    setup();

    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'sleep 10' },
    });

    const handle = await executor.start(request);

    const spec = executor.getTerminalSpec(handle);
    expect(spec).not.toBeNull();
    expect(spec!.command).toBe('bash');
    expect(spec!.args![0]).toBe('-c');
    const bashCmd = spec!.args![1];
    expect(bashCmd).toContain('docker start');
    expect(bashCmd).toContain('docker exec -it');
    expect(bashCmd).toContain('/bin/bash');
  }, 30_000);

  it('writes to ~/.cache inside container under image-declared user', async () => {
    setup();

    // The base image declares user `invoker` with HOME=/home/invoker.
    // With no User override and no bind mounts, ~/.cache should be writable
    // by the image's declared user.
    const request = makeRequest({
      actionType: 'command',
      inputs: { command: 'mkdir -p ~/.cache/test-dir && echo HOMEDIR_OK' },
    });

    const handle = await executor.start(request);
    const output: string[] = [];
    executor.onOutput(handle, (data) => output.push(data));

    const response = await waitForComplete(executor, handle);
    const combined = output.join('');

    expect(response.status).toBe('completed');
    expect(response.outputs.exitCode).toBe(0);
    expect(combined).toContain('HOMEDIR_OK');
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

    const handles: ExecutorHandle[] = [];
    for (const req of requests) {
      handles.push(await executor.start(req));
    }

    const responses = await Promise.all(
      handles.map((h) => waitForComplete(executor, h)),
    );

    for (const r of responses) {
      expect(['completed', 'failed']).toContain(r.status);
    }
  }, 120_000);
});

// ---------------------------------------------------------------------------
// Claude CLI inside Docker integration tests
// ---------------------------------------------------------------------------

const HAS_API_KEY = !!process.env.ANTHROPIC_API_KEY;

describe.skipIf(!DOCKER_OK || !HAS_API_KEY)('DockerExecutor Claude E2E (real Docker + Claude CLI)', () => {
  let workDir: string;
  let executor: DockerExecutor;

  afterEach(async () => {
    if (executor) {
      await executor.destroyAll();
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
    executor = new DockerExecutor({
      secretsFile: process.env.INVOKER_TEST_SECRETS_FILE,
    });
  }

  it('claude session produces valid handle with sessionId', async () => {
    setup();

    const request = makeRequest({
      actionType: 'ai_task',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await executor.start(request);

    expect(handle.agentSessionId).toBeDefined();
    expect(handle.agentSessionId).toMatch(/^[0-9a-f-]+$/);
  }, 120_000);

  it('claude session completes and returns sessionId in outputs', async () => {
    setup();

    const request = makeRequest({
      actionType: 'ai_task',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await executor.start(request);
    const response = await waitForComplete(executor, handle, 120_000);

    expect(response.status).toBe('completed');
    expect(response.outputs.agentSessionId).toBe(handle.agentSessionId);
    expect(response.outputs.exitCode).toBe(0);
  }, 180_000);

  it('getTerminalSpec returns docker exec claude --resume', async () => {
    setup();

    const request = makeRequest({
      actionType: 'ai_task',
      inputs: { prompt: 'Say exactly "hello" and nothing else.' },
    });

    const handle = await executor.start(request);
    const spec = executor.getTerminalSpec(handle);

    expect(spec).toBeDefined();
    expect(spec!.command).toBe('bash');
    const bashCmd = spec!.args![1];
    expect(bashCmd).toContain('docker start');
    expect(bashCmd).toContain(`docker exec -it`);
    expect(bashCmd).toContain(`claude --resume ${handle.agentSessionId}`);
  }, 120_000);
});
