import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
}));

function createMockProcess(): ChildProcess & EventEmitter {
  const proc = new EventEmitter() as ChildProcess & EventEmitter;
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  (proc as any).stdout = stdout;
  (proc as any).stderr = stderr;
  (proc as any).pid = 4321;
  proc.kill = vi.fn().mockReturnValue(true);
  return proc;
}

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');
const originalPath = process.env.PATH;
const originalShell = process.env.SHELL;
const originalElectronRunAsNode = process.env.ELECTRON_RUN_AS_NODE;
const originalElectronNoAsar = process.env.ELECTRON_NO_ASAR;
const originalElectronNoAttachConsole = process.env.ELECTRON_NO_ATTACH_CONSOLE;
const originalInvokerRepoConfigPath = process.env.INVOKER_REPO_CONFIG_PATH;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

async function loadProcessUtils() {
  vi.resetModules();
  const childProcess = await import('node:child_process');
  const processUtils = await import('../process-utils.js');
  return { processUtils, mockedSpawn: vi.mocked(childProcess.spawn) };
}

describe('process-utils shell environment resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
    if (originalPath === undefined) delete process.env.PATH;
    else process.env.PATH = originalPath;
    if (originalShell === undefined) delete process.env.SHELL;
    else process.env.SHELL = originalShell;
    if (originalElectronRunAsNode === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
    else process.env.ELECTRON_RUN_AS_NODE = originalElectronRunAsNode;
    if (originalElectronNoAsar === undefined) delete process.env.ELECTRON_NO_ASAR;
    else process.env.ELECTRON_NO_ASAR = originalElectronNoAsar;
    if (originalElectronNoAttachConsole === undefined) delete process.env.ELECTRON_NO_ATTACH_CONSOLE;
    else process.env.ELECTRON_NO_ATTACH_CONSOLE = originalElectronNoAttachConsole;
    if (originalInvokerRepoConfigPath === undefined) delete process.env.INVOKER_REPO_CONFIG_PATH;
    else process.env.INVOKER_REPO_CONFIG_PATH = originalInvokerRepoConfigPath;
  });

  afterEach(() => {
    if (originalPlatformDescriptor) {
      Object.defineProperty(process, 'platform', originalPlatformDescriptor);
    }
  });

  it('parses shell PATH markers from noisy output', async () => {
    const { processUtils } = await loadProcessUtils();
    const parsed = processUtils.parseResolvedShellPath(
      'warning\n__INVOKER_EFFECTIVE_PATH_START__/opt/homebrew/bin:/usr/bin__INVOKER_EFFECTIVE_PATH_END__\nfooter',
    );
    expect(parsed).toBe('/opt/homebrew/bin:/usr/bin');
  });

  it('prepends common Homebrew paths in the macOS fallback PATH', async () => {
    setPlatform('darwin');
    const { processUtils } = await loadProcessUtils();
    expect(processUtils.applyMacOSPathFallback('/usr/bin:/bin:/usr/local/bin')).toBe(
      '/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin',
    );
  });

  it('initializes and caches the resolved shell PATH on macOS', async () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.ELECTRON_NO_ASAR = '1';
    process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';
    process.env.INVOKER_REPO_CONFIG_PATH = '/tmp/operator-only-repo-config.json';

    const { processUtils, mockedSpawn } = await loadProcessUtils();
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(proc as never);

    const initPromise = processUtils.initializeShellEnvironment();
    proc.stdout?.emit(
      'data',
      Buffer.from(
        'noise before __INVOKER_EFFECTIVE_PATH_START__/opt/homebrew/bin:/Users/test/.local/bin:/usr/bin__INVOKER_EFFECTIVE_PATH_END__ noise after',
      ),
    );
    proc.emit('close', 0, null);

    const result = await initPromise;
    expect(result.status).toBe('resolved');
    expect(result.path).toBe('/usr/bin:/bin:/opt/homebrew/bin:/Users/test/.local/bin:/usr/local/bin');
    expect(process.env.PATH).toBe(result.path);
    expect(processUtils.getEffectivePath()).toBe(result.path);
    expect(processUtils.cleanElectronEnv()).toMatchObject({
      PATH: result.path,
    });
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_NO_ASAR');
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_NO_ATTACH_CONSOLE');
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('INVOKER_REPO_CONFIG_PATH');

    const second = await processUtils.initializeShellEnvironment();
    expect(second).toEqual(result);
    expect(mockedSpawn).toHaveBeenCalledTimes(1);
  });

  it('falls back cleanly when shell resolution times out', async () => {
    setPlatform('darwin');
    process.env.PATH = '/usr/bin:/bin';

    const { processUtils, mockedSpawn } = await loadProcessUtils();
    const proc = createMockProcess();
    mockedSpawn.mockReturnValue(proc as never);

    await expect(processUtils.probeMacOSShellPath('/bin/zsh', 5)).rejects.toThrow(/timed out/);
    expect(proc.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('skips shell probing outside macOS', async () => {
    setPlatform('linux');
    process.env.PATH = '/usr/local/bin:/usr/bin:/bin';

    const { processUtils, mockedSpawn } = await loadProcessUtils();
    const result = await processUtils.initializeShellEnvironment();

    expect(result.status).toBe('skipped');
    expect(result.path).toBe('/usr/local/bin:/usr/bin:/bin');
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it('resolves executables from the current runtime PATH before cleaned child env is applied', async () => {
    const { processUtils } = await loadProcessUtils();
    const dir = mkdtempSync(join(tmpdir(), 'invoker-codex-path-'));
    const codex = join(dir, 'codex');
    try {
      writeFileSync(codex, '#!/usr/bin/env bash\nexit 0\n');
      chmodSync(codex, 0o755);
      process.env.PATH = `${dir}${process.env.PATH ? `:${process.env.PATH}` : ''}`;

      expect(processUtils.resolveExecutableOnCurrentPath('codex')).toBe(codex);
      expect(processUtils.resolveExecutableOnCurrentPath('/explicit/codex')).toBe('/explicit/codex');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('childProcessHasExited', () => {
  it('treats unset mock exit fields as still running', async () => {
    const { processUtils } = await loadProcessUtils();
    const child = createMockProcess();

    expect(processUtils.childProcessHasExited(child)).toBe(false);
  });

  it('detects exited and signaled child processes', async () => {
    const { processUtils } = await loadProcessUtils();
    const exited = createMockProcess();
    const signaled = createMockProcess();
    (exited as any).exitCode = 0;
    (signaled as any).exitCode = null;
    (signaled as any).signalCode = 'SIGTERM';

    expect(processUtils.childProcessHasExited(exited)).toBe(true);
    expect(processUtils.childProcessHasExited(signaled)).toBe(true);
  });
});

describe('terminateChildProcessGroup', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns without signaling an already exited child process', async () => {
    const { processUtils } = await loadProcessUtils();
    const child = createMockProcess();
    (child as any).exitCode = 0;

    await processUtils.terminateChildProcessGroup(child, () => false);

    expect(child.kill).not.toHaveBeenCalled();
  });

  it('sends SIGTERM and resolves when the child closes', async () => {
    const { processUtils } = await loadProcessUtils();
    const child = createMockProcess();

    const killed = processUtils.terminateChildProcessGroup(child, () => false);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    child.emit('close', null, 'SIGTERM');
    await expect(killed).resolves.toBeUndefined();
  });

  it('escalates to SIGKILL when the child does not close', async () => {
    vi.useFakeTimers();
    const { processUtils } = await loadProcessUtils();
    const child = createMockProcess();

    const killed = processUtils.terminateChildProcessGroup(child, () => false);

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    await vi.advanceTimersByTimeAsync(processUtils.SIGKILL_TIMEOUT_MS);
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    child.emit('close', null, 'SIGKILL');
    await expect(killed).resolves.toBeUndefined();
  });
});

describe('buildAgentExitFailureDetail', () => {
  it('surfaces the codex --json stdout error instead of the benign stdin noise', async () => {
    const { processUtils } = await loadProcessUtils();
    const stdout = [
      JSON.stringify({ type: 'thread.started', thread_id: 't1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'Model refused: quota exceeded' } }),
    ].join('\n');
    const displayStdout = '[assistant] Model refused: quota exceeded';
    const detail = processUtils.buildAgentExitFailureDetail(
      stdout,
      'Reading additional input from stdin...\n',
      displayStdout,
    );
    expect(detail).toBe('[assistant] Model refused: quota exceeded');
    expect(detail).not.toContain('Reading additional input from stdin');
  });

  it('prefers meaningful stderr with the benign stdin noise stripped', async () => {
    const { processUtils } = await loadProcessUtils();
    const detail = processUtils.buildAgentExitFailureDetail(
      'stdout should be ignored when stderr has signal',
      'Reading additional input from stdin...\npanic: boom at line 5\n',
      'display',
    );
    expect(detail).toBe('panic: boom at line 5');
  });

  it('falls back to raw stdout when no driver-processed output is available', async () => {
    const { processUtils } = await loadProcessUtils();
    const detail = processUtils.buildAgentExitFailureDetail(
      'raw json line',
      'Reading additional input from stdin...',
      undefined,
    );
    expect(detail).toBe('raw json line');
  });

  it('returns an actionable hint when only the codex stdin/TTY noise was emitted', async () => {
    const { processUtils } = await loadProcessUtils();
    const detail = processUtils.buildAgentExitFailureDetail(
      '',
      'Reading additional input from stdin...\n',
      '',
    );
    expect(detail).toContain('without a controlling TTY');
    expect(detail).toContain('openai/codex#19945');
  });

  it('returns the actionable hint when the stdin/TTY noise landed on stdout, not stderr', async () => {
    // Regression: codex can print "Reading additional input from stdin..." to STDOUT
    // and die before emitting any JSONL. The readable output is empty (no messages
    // parsed) and stderr is empty, so the old raw-stdout fallback echoed the noise
    // verbatim as "codex fix exited with code 1: Reading additional input from stdin...".
    const { processUtils } = await loadProcessUtils();
    const detail = processUtils.buildAgentExitFailureDetail(
      'Reading additional input from stdin...\n',
      '',
      '',
    );
    expect(detail).toContain('without a controlling TTY');
    expect(detail).toContain('openai/codex#19945');
    // The raw noise must not leak through as the whole detail.
    expect(detail).not.toBe('Reading additional input from stdin...');
  });

  it('returns (no output) when the process emitted nothing at all', async () => {
    const { processUtils } = await loadProcessUtils();
    expect(processUtils.buildAgentExitFailureDetail('', '', '')).toBe('(no output)');
  });

  it('tail-limits very long output to keep messages bounded', async () => {
    const { processUtils } = await loadProcessUtils();
    const huge = 'x'.repeat(5000);
    const detail = processUtils.buildAgentExitFailureDetail(huge, '', huge);
    expect(detail.length).toBe(2000);
    expect(detail).toBe(huge.slice(-2000));
  });
});
