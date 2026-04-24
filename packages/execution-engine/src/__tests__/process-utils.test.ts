import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';

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
      '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    );
  });

  it('initializes and caches the resolved shell PATH on macOS', async () => {
    setPlatform('darwin');
    process.env.SHELL = '/bin/zsh';
    process.env.PATH = '/usr/bin:/bin';
    process.env.ELECTRON_RUN_AS_NODE = '1';
    process.env.ELECTRON_NO_ASAR = '1';
    process.env.ELECTRON_NO_ATTACH_CONSOLE = '1';

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
    expect(result.path).toBe('/opt/homebrew/bin:/usr/local/bin:/Users/test/.local/bin:/usr/bin');
    expect(process.env.PATH).toBe(result.path);
    expect(processUtils.getEffectivePath()).toBe(result.path);
    expect(processUtils.cleanElectronEnv()).toMatchObject({
      PATH: result.path,
    });
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_NO_ASAR');
    expect(processUtils.cleanElectronEnv()).not.toHaveProperty('ELECTRON_NO_ATTACH_CONSOLE');

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
});
