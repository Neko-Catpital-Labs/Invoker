import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-app.js';

type ReproMode = 'before' | 'after';

type ResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
};

type SttySample = {
  label: 'before' | 'after';
  rows: number;
  cols: number;
};

type ReproArtifact = {
  mode: ReproMode;
  sessionId: string;
  resizeProbe: 'window.invoker' | 'ipcMain' | 'stty-inferred';
  resizePayloads: ResizePayload[];
  outputSnapshotTail: string;
  sttySamples: SttySample[];
  screenshotPaths: {
    beforeZeroHost: string;
    afterZeroHost: string;
  };
  tinyResizePayloads: ResizePayload[];
  tinySttySamples: SttySample[];
};

type ProbeWindow = Window & {
  __planningTmuxBlankOriginalResize?: (
    sessionId: string,
    cols: number,
    rows: number,
  ) => Promise<{ ok: boolean; reason?: string }>;
  __planningTmuxBlankResizePayloads?: ResizePayload[];
  __planningTmuxBlankOutput?: string;
  __planningTmuxBlankSessionId?: string;
  __planningTmuxBlankUnsubscribe?: () => void;
  __planningTmuxBlankEarlyInstalled?: boolean;
};

const mode: ReproMode = process.env.INVOKER_PLANNING_TMUX_BLANK_EXPECT === 'before' ? 'before' : 'after';
const artifactRoot = process.env.INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR
  ? path.resolve(process.env.INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR)
  : path.resolve(process.cwd(), 'test-results', 'planning-tmux-blank-repro', mode);
const artifactJsonPath = path.join(artifactRoot, `planning-tmux-blank-${mode}.json`);

function isTinyGeometry(sample: { cols: number; rows: number }): boolean {
  return sample.rows <= 5 || sample.cols <= 20;
}

function stripAnsi(raw: string): string {
  return raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '');
}

function parseSttySamples(output: string): SttySample[] {
  const clean = stripAnsi(output);
  const samples: SttySample[] = [];
  const pattern = /TMUX_SIZE\s+(before|after)\s+(\d+)\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    samples.push({
      label: match[1] as 'before' | 'after',
      rows: Number(match[2]),
      cols: Number(match[3]),
    });
  }
  return samples;
}

async function animationFrame(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
}

async function waitForResizeObserverTurn(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    if (!pane || typeof ResizeObserver === 'undefined') {
      setTimeout(resolve, 0);
      return;
    }
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      observer.disconnect();
      resolve();
    };
    const observer = new ResizeObserver(() => finish());
    observer.observe(pane);
    setTimeout(finish, 100);
  }));
}

async function installEarlyPageProbe(page: Page): Promise<boolean> {
  await page.addInitScript(() => {
    const probeWindow = window as ProbeWindow & {
      __planningTmuxBlankInvokerProxy?: typeof window.invoker;
    };
    probeWindow.__planningTmuxBlankResizePayloads = [];
    probeWindow.__planningTmuxBlankOutput = '';
    probeWindow.__planningTmuxBlankSessionId = undefined;
    probeWindow.__planningTmuxBlankEarlyInstalled = false;

    const wrapInvoker = (invoker: typeof window.invoker): typeof window.invoker => {
      if (probeWindow.__planningTmuxBlankInvokerProxy) return probeWindow.__planningTmuxBlankInvokerProxy;
      const originalResize = invoker.planningTerminalResize.bind(invoker);
      const wrappedResize = async (sessionId: string, cols: number, rows: number) => {
        probeWindow.__planningTmuxBlankResizePayloads?.push({ sessionId, cols, rows });
        return originalResize(sessionId, cols, rows);
      };
      const proxy = new Proxy(invoker, {
        get(target, property, receiver) {
          if (property === 'planningTerminalResize') return wrappedResize;
          const value = Reflect.get(target, property, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      probeWindow.__planningTmuxBlankInvokerProxy = proxy;
      probeWindow.__planningTmuxBlankEarlyInstalled = true;
      probeWindow.__planningTmuxBlankUnsubscribe = proxy.onTerminalOutput((event) => {
        const sessionId = probeWindow.__planningTmuxBlankSessionId;
        if (sessionId && event.sessionId !== sessionId) return;
        const next = `${probeWindow.__planningTmuxBlankOutput ?? ''}${event.data}`;
        probeWindow.__planningTmuxBlankOutput = next.length > 50000 ? next.slice(next.length - 50000) : next;
      });
      return proxy;
    };

    let invokerValue: typeof window.invoker | undefined;
    try {
      Object.defineProperty(window, 'invoker', {
        configurable: true,
        get() {
          return invokerValue;
        },
        set(value: typeof window.invoker) {
          invokerValue = wrapInvoker(value);
        },
      });
    } catch {
      /* contextBridge may install the property first */
    }
  });
  await page.reload();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 10000 });
  return page.evaluate(() => Boolean((window as ProbeWindow).__planningTmuxBlankEarlyInstalled));
}

async function installPageProbe(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const probeWindow = window as ProbeWindow;
    probeWindow.__planningTmuxBlankResizePayloads = [];
    probeWindow.__planningTmuxBlankOutput = '';
    probeWindow.__planningTmuxBlankSessionId = undefined;
    probeWindow.__planningTmuxBlankUnsubscribe?.();
    probeWindow.__planningTmuxBlankUnsubscribe = undefined;

    const invoker = window.invoker;
    const currentResize = invoker.planningTerminalResize.bind(invoker);
    if (!probeWindow.__planningTmuxBlankOriginalResize) {
      probeWindow.__planningTmuxBlankOriginalResize = currentResize;
    }
    const originalResize = probeWindow.__planningTmuxBlankOriginalResize;
    const wrappedResize = async (sessionId: string, cols: number, rows: number) => {
      probeWindow.__planningTmuxBlankResizePayloads?.push({ sessionId, cols, rows });
      return originalResize(sessionId, cols, rows);
    };

    let installed = false;
    try {
      invoker.planningTerminalResize = wrappedResize;
      installed = invoker.planningTerminalResize === wrappedResize;
    } catch {
      installed = false;
    }
    if (!installed) {
      try {
        Object.defineProperty(invoker, 'planningTerminalResize', {
          configurable: true,
          value: wrappedResize,
        });
        installed = invoker.planningTerminalResize === wrappedResize;
      } catch {
        installed = false;
      }
    }
    if (!installed) {
      const replacement: Record<string, unknown> = {};
      const invokerRecord = invoker as unknown as Record<string, unknown>;
      for (const key of Object.getOwnPropertyNames(invokerRecord)) {
        replacement[key] = invokerRecord[key];
      }
      replacement.planningTerminalResize = wrappedResize;
      try {
        Object.defineProperty(window, 'invoker', {
          configurable: true,
          value: replacement,
        });
        installed = window.invoker.planningTerminalResize === wrappedResize;
      } catch {
        installed = false;
      }
    }
    probeWindow.__planningTmuxBlankUnsubscribe = window.invoker.onTerminalOutput((event) => {
      const sessionId = probeWindow.__planningTmuxBlankSessionId;
      if (sessionId && event.sessionId !== sessionId) return;
      const next = `${probeWindow.__planningTmuxBlankOutput ?? ''}${event.data}`;
      probeWindow.__planningTmuxBlankOutput = next.length > 50000 ? next.slice(next.length - 50000) : next;
    });
    return installed;
  });
}

async function installMainProcessResizeProbe(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const globalProbe = globalThis as typeof globalThis & {
      __planningTmuxBlankResizePayloads?: ResizePayload[];
      __planningTmuxBlankOriginalResizeHandler?: (...args: unknown[]) => unknown;
    };
    const ipcMainInternals = ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...args: unknown[]) => unknown>;
    };
    const handlers = ipcMainInternals._invokeHandlers;
    const channel = 'invoker:planning-terminal-resize';
    const originalHandler = handlers?.get(channel);
    if (!handlers || typeof handlers.get !== 'function' || typeof handlers.set !== 'function' || !originalHandler) {
      throw new Error('Failed to locate Electron ipcMain invoke handler for planning terminal resize.');
    }

    globalProbe.__planningTmuxBlankResizePayloads = [];
    if (!globalProbe.__planningTmuxBlankOriginalResizeHandler) {
      globalProbe.__planningTmuxBlankOriginalResizeHandler = originalHandler;
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, async (...args: unknown[]) => {
        const offset = typeof args[0] === 'string' ? 0 : 1;
        const [sessionId, cols, rows] = args.slice(offset);
        globalProbe.__planningTmuxBlankResizePayloads?.push({
          sessionId: String(sessionId ?? ''),
          cols: Number(cols),
          rows: Number(rows),
        });
        return globalProbe.__planningTmuxBlankOriginalResizeHandler?.(...args);
      });
    }
  });
}

async function getMainProcessResizePayloads(electronApp: ElectronApplication, sessionId: string): Promise<ResizePayload[]> {
  return electronApp.evaluate((expectedSessionId) => {
    const globalProbe = globalThis as typeof globalThis & {
      __planningTmuxBlankResizePayloads?: ResizePayload[];
    };
    return (globalProbe.__planningTmuxBlankResizePayloads ?? [])
      .filter((payload) => payload.sessionId === expectedSessionId);
  }, sessionId);
}

async function getResizePayloads(
  page: Page,
  electronApp: ElectronApplication,
  sessionId: string,
  resizeProbe: ReproArtifact['resizeProbe'],
): Promise<ResizePayload[]> {
  if (resizeProbe === 'ipcMain') {
    return getMainProcessResizePayloads(electronApp, sessionId);
  }
  return page.evaluate((expectedSessionId) => {
    const probeWindow = window as ProbeWindow;
    return (probeWindow.__planningTmuxBlankResizePayloads ?? [])
      .filter((payload) => payload.sessionId === expectedSessionId);
  }, sessionId);
}

async function getOutputTail(page: Page): Promise<string> {
  return page.evaluate(() => {
    const probeWindow = window as ProbeWindow;
    return probeWindow.__planningTmuxBlankOutput ?? '';
  });
}

async function writeShellMarker(page: Page, sessionId: string, label: 'before' | 'after'): Promise<void> {
  const result = await page.evaluate(
    async ({ targetSessionId, sampleLabel }) => window.invoker.planningTerminalWrite(
      targetSessionId,
      `printf '\\nTMUX_SIZE ${sampleLabel} '; stty size; printf 'TMUX_DONE ${sampleLabel}\\n'\r`,
    ),
    { targetSessionId: sessionId, sampleLabel: label },
  );
  expect(result.ok, result.reason).toBe(true);
}

async function waitForSttySample(page: Page, label: 'before' | 'after'): Promise<void> {
  await expect.poll(async () => parseSttySamples(await getOutputTail(page)).some((sample) => sample.label === label), {
    timeout: 10000,
  }).toBe(true);
}

async function captureArtifact(
  page: Page,
  electronApp: ElectronApplication,
  artifact: Omit<ReproArtifact, 'resizePayloads' | 'outputSnapshotTail' | 'sttySamples' | 'tinyResizePayloads' | 'tinySttySamples'>,
): Promise<ReproArtifact> {
  const outputSnapshotTail = await getOutputTail(page);
  const sttySamples = parseSttySamples(outputSnapshotTail);
  const actualResizePayloads = artifact.resizeProbe === 'stty-inferred'
    ? []
    : await getResizePayloads(page, electronApp, artifact.sessionId, artifact.resizeProbe);
  const resizePayloads = actualResizePayloads.length > 0
    ? actualResizePayloads
    : sttySamples.map((sample) => ({
      sessionId: artifact.sessionId,
      cols: sample.cols,
      rows: sample.rows,
    }));
  return {
    ...artifact,
    resizeProbe: actualResizePayloads.length > 0 ? artifact.resizeProbe : 'stty-inferred',
    resizePayloads,
    outputSnapshotTail: stripAnsi(outputSnapshotTail).slice(-12000),
    sttySamples,
    tinyResizePayloads: resizePayloads.filter(isTinyGeometry),
    tinySttySamples: sttySamples.filter(isTinyGeometry),
  };
}

test.describe('Planning tmux blank repro', () => {
  test('hidden or zero-sized tmux host must not shrink the live planning PTY', async ({ page, electronApp }) => {
    await mkdir(artifactRoot, { recursive: true });
    const screenshotPaths = {
      beforeZeroHost: path.join(artifactRoot, `planning-tmux-blank-${mode}-before-zero-host.png`),
      afterZeroHost: path.join(artifactRoot, `planning-tmux-blank-${mode}-after-zero-host.png`),
    };

    let sessionId = '';
    let resizeProbe: ReproArtifact['resizeProbe'] = 'window.invoker';
    let finalArtifact: ReproArtifact | null = null;

    try {
      const earlyPageProbeInstalled = await installEarlyPageProbe(page);
      await page.setViewportSize({ width: 1200, height: 800 });
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });

      const pageProbeInstalled = earlyPageProbeInstalled || await installPageProbe(page);
      if (!pageProbeInstalled) {
        resizeProbe = 'ipcMain';
        await installMainProcessResizeProbe(electronApp);
      }

      await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
      const tmuxPane = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(tmuxPane).toBeVisible({ timeout: 15000 });
      sessionId = await tmuxPane.getAttribute('data-session-id') ?? '';
      expect(sessionId).toBeTruthy();
      await page.evaluate((targetSessionId) => {
        const probeWindow = window as ProbeWindow;
        probeWindow.__planningTmuxBlankSessionId = targetSessionId;
      }, sessionId);

      await animationFrame(page);
      await animationFrame(page);
      await page.waitForTimeout(500);

      await writeShellMarker(page, sessionId, 'before');
      await waitForSttySample(page, 'before');
      await page.screenshot({ path: screenshotPaths.beforeZeroHost, fullPage: true });

      await page.addStyleTag({
        content: `
[data-testid="invoker-terminal-tmux-pane"] {
  width: 0px !important;
  height: 0px !important;
  min-width: 0px !important;
  min-height: 0px !important;
  max-width: 0px !important;
  max-height: 0px !important;
  padding: 0px !important;
  border: 0px !important;
}
`,
      });
      await page.waitForFunction(() => {
        const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
        if (!pane) return false;
        const rect = pane.getBoundingClientRect();
        return rect.width === 0 && rect.height === 0;
      }, null, { timeout: 5000 });
      await animationFrame(page);
      await animationFrame(page);
      await waitForResizeObserverTurn(page);
      await page.waitForTimeout(1000);

      await writeShellMarker(page, sessionId, 'after');
      await waitForSttySample(page, 'after');
      await page.screenshot({ path: screenshotPaths.afterZeroHost, fullPage: true });

      finalArtifact = await captureArtifact(page, electronApp, {
        resizeProbe,
        mode,
        sessionId,
        screenshotPaths,
      });

      if (mode === 'before') {
        expect(finalArtifact.tinyResizePayloads.length, 'expected a tiny planningTerminalResize payload in before mode').toBeGreaterThan(0);
        expect(finalArtifact.tinySttySamples.length, 'expected stty size to observe tiny PTY geometry in before mode').toBeGreaterThan(0);
      } else {
        expect(finalArtifact.tinyResizePayloads, 'after mode must not send tiny planningTerminalResize payloads').toEqual([]);
        expect(finalArtifact.tinySttySamples, 'after mode must not observe tiny PTY geometry').toEqual([]);
      }
    } finally {
      if (sessionId) {
        finalArtifact = await captureArtifact(page, electronApp, {
          resizeProbe,
          mode,
          sessionId,
          screenshotPaths,
        }).catch(() => finalArtifact);
      }
      if (finalArtifact) {
        await mkdir(artifactRoot, { recursive: true });
        await writeFile(
          artifactJsonPath,
          `${JSON.stringify(finalArtifact, null, 2)}\n`,
          'utf8',
        );
      }
    }
  });
});
