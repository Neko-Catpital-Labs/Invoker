import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test, waitForStableUI } from './fixtures/electron-app.js';

type ReproMode = 'before' | 'after';

type ResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
};

type TerminalOutputPayload = {
  sessionId: string;
  data: string;
};

type SizeSample = {
  label: 'before' | 'after';
  rows: number;
  cols: number;
};

type ReproCaptureState = {
  resizePayloads: ResizePayload[];
  terminalOutput: TerminalOutputPayload[];
  resizeWrapped: boolean;
  resizeWrapperProbeRecorded: boolean;
};

const TINY_ROWS = 5;
const TINY_COLS = 20;

test.use({
  repoConfig: { autoFixRetries: 0, disableAutoRunOnStartup: true },
});

function reproMode(): ReproMode {
  const value = process.env.INVOKER_PLANNING_TMUX_BLANK_EXPECT ?? 'after';
  if (value === 'before' || value === 'after') return value;
  throw new Error(`INVOKER_PLANNING_TMUX_BLANK_EXPECT must be "before" or "after"; got "${value}"`);
}

function isTinyGeometry(payload: { rows: number; cols: number }): boolean {
  return payload.rows <= TINY_ROWS || payload.cols <= TINY_COLS;
}

function stripAnsi(input: string): string {
  return input
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\r/g, '\n');
}

function parseSizeSamples(rawOutput: string): SizeSample[] {
  const normalized = stripAnsi(rawOutput);
  const samples: SizeSample[] = [];
  const pattern = /TMUX_SIZE\s+(before|after)\s+(\d+)\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(normalized)) !== null) {
    samples.push({
      label: match[1] as 'before' | 'after',
      rows: Number(match[2]),
      cols: Number(match[3]),
    });
  }
  return samples;
}

function outputTail(rawOutput: string): string {
  const normalized = stripAnsi(rawOutput);
  return normalized.slice(Math.max(0, normalized.length - 4000));
}

async function installCaptureHooks(page: Page, electronApp: ElectronApplication): Promise<void> {
  await page.evaluate(() => {
    const state: ReproCaptureState = {
      resizePayloads: [],
      terminalOutput: [],
      resizeWrapped: false,
      resizeWrapperProbeRecorded: false,
    };
    const win = window as typeof window & { __PLANNING_TMUX_BLANK_REPRO__?: ReproCaptureState };
    win.__PLANNING_TMUX_BLANK_REPRO__ = state;

    window.invoker.onTerminalOutput?.((event) => {
      state.terminalOutput.push({
        sessionId: event.sessionId,
        data: event.data,
      });
    });
  });

  await electronApp.evaluate(({ ipcMain }) => {
    const store = globalThis as typeof globalThis & {
      __PLANNING_TMUX_BLANK_REPRO_RESIZES__?: ResizePayload[];
      __PLANNING_TMUX_BLANK_REPRO_RESIZE_WRAPPED__?: boolean;
      __PLANNING_TMUX_BLANK_REPRO_RESIZE_PROBE_RECORDED__?: boolean;
    };
    store.__PLANNING_TMUX_BLANK_REPRO_RESIZES__ = [];
    store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_WRAPPED__ = false;
    store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_PROBE_RECORDED__ = false;

    const channel = 'invoker:planning-terminal-resize';
    const ipcMainWithHandlers = ipcMain as unknown as {
      _invokeHandlers?: Map<string, (event: unknown, ...args: unknown[]) => unknown>;
    };
    const handlers = ipcMainWithHandlers._invokeHandlers;
    const originalHandler = handlers?.get(channel);
    if (!handlers || !originalHandler) {
      throw new Error('Unable to locate Electron invoke handler for invoker:planning-terminal-resize');
    }

    const wrappedHandler = async (event: unknown, sessionId: unknown, cols: unknown, rows: unknown, ...rest: unknown[]) => {
      const payload = {
        sessionId: String(sessionId),
        cols: Number(cols),
        rows: Number(rows),
      };
      store.__PLANNING_TMUX_BLANK_REPRO_RESIZES__?.push(payload);
      if (payload.sessionId === '__planning_tmux_blank_repro_probe__') {
        store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_PROBE_RECORDED__ = true;
      }
      return originalHandler(event, sessionId, cols, rows, ...rest);
    };
    handlers.set(channel, wrappedHandler);
    store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_WRAPPED__ = true;
  });
}

async function getCaptureState(page: Page, electronApp: ElectronApplication): Promise<ReproCaptureState> {
  const pageState = await page.evaluate(() => {
    const win = window as typeof window & { __PLANNING_TMUX_BLANK_REPRO__?: ReproCaptureState };
    return win.__PLANNING_TMUX_BLANK_REPRO__ ?? {
      resizePayloads: [],
      terminalOutput: [],
      resizeWrapped: false,
      resizeWrapperProbeRecorded: false,
    };
  });
  const mainState = await electronApp.evaluate(() => {
    const store = globalThis as typeof globalThis & {
      __PLANNING_TMUX_BLANK_REPRO_RESIZES__?: ResizePayload[];
      __PLANNING_TMUX_BLANK_REPRO_RESIZE_WRAPPED__?: boolean;
      __PLANNING_TMUX_BLANK_REPRO_RESIZE_PROBE_RECORDED__?: boolean;
    };
    return {
      resizePayloads: store.__PLANNING_TMUX_BLANK_REPRO_RESIZES__ ?? [],
      resizeWrapped: store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_WRAPPED__ === true,
      resizeWrapperProbeRecorded: store.__PLANNING_TMUX_BLANK_REPRO_RESIZE_PROBE_RECORDED__ === true,
    };
  });
  return {
    resizePayloads: mainState.resizePayloads,
    terminalOutput: pageState.terminalOutput,
    resizeWrapped: mainState.resizeWrapped,
    resizeWrapperProbeRecorded: mainState.resizeWrapperProbeRecorded,
  };
}

async function openPlanningTmux(page: Page): Promise<string> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId, 'planning tmux pane exposes a terminal session id').toBeTruthy();
  return sessionId ?? '';
}

async function writeSizeMarker(page: Page, electronApp: ElectronApplication, sessionId: string, label: 'before' | 'after'): Promise<void> {
  const command = `printf '\\nTMUX_SIZE ${label} '; stty size`;
  await page.evaluate(async ({ targetSessionId, line }) => {
    await window.invoker.planningTerminalWrite(targetSessionId, `${line}\r`);
  }, { targetSessionId: sessionId, line: command });

  await expect.poll(async () => {
    const state = await getCaptureState(page, electronApp);
    return parseSizeSamples(state.terminalOutput.map((event) => event.data).join(''))
      .some((sample) => sample.label === label);
  }, {
    message: `expected a TMUX_SIZE ${label} stty sample`,
    timeout: 10000,
  }).toBe(true);
}

async function forceZeroSizeHostTransition(page: Page): Promise<{ afterTiny: { width: number; height: number }; afterZero: { width: number; height: number } }> {
  return page.evaluate(async () => {
    const selector = '[data-testid="invoker-terminal-tmux-pane"]';
    const host = document.querySelector<HTMLElement>(selector);
    if (!host) throw new Error(`${selector} not found`);

    const waitForObservedFrame = async (): Promise<void> => {
      await new Promise<void>((resolve) => {
        let resolved = false;
        let observerSawResize = false;
        const resizeObserver = new ResizeObserver(() => {
          observerSawResize = true;
          requestAnimationFrame(() => finish());
        });
        const finish = () => {
          if (resolved) return;
          resolved = true;
          resizeObserver.disconnect();
          resolve();
        };
        resizeObserver.observe(host);
        host.getBoundingClientRect();
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            if (!observerSawResize) {
              setTimeout(finish, 0);
            }
          });
        });
      });
    };

    const style = document.createElement('style');
    style.setAttribute('data-testid', 'planning-tmux-zero-host-style');
    document.head.appendChild(style);

    const setHostSize = async (widthPx: number, heightPx: number): Promise<{ width: number; height: number }> => {
      style.textContent = `
        [data-testid="invoker-terminal-tmux-pane"] {
          position: absolute !important;
          inset: auto !important;
          left: 0 !important;
          top: 0 !important;
          width: ${widthPx}px !important;
          height: ${heightPx}px !important;
          min-width: 0 !important;
          min-height: 0 !important;
          max-width: ${widthPx}px !important;
          max-height: ${heightPx}px !important;
          padding: 0 !important;
          border: 0 !important;
          overflow: hidden !important;
        }
      `;
      await waitForObservedFrame();
      const rect = host.getBoundingClientRect();
      return { width: rect.width, height: rect.height };
    };

    const afterTiny = await setHostSize(12, 12);
    const afterZero = await setHostSize(0, 0);
    return { afterTiny, afterZero };
  });
}

async function readZeroHostRect(page: Page): Promise<{ width: number; height: number }> {
  return page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="invoker-terminal-tmux-pane"]');
    if (!host) return { width: -1, height: -1 };
    const rect = host.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
}

async function saveArtifacts(params: {
  page: Page;
  electronApp: ElectronApplication;
  mode: ReproMode;
  sessionId: string;
  jsonPath: string;
  beforeScreenshotPath: string;
  afterScreenshotPath: string;
  hostRects: {
    afterTiny: { width: number; height: number };
    afterZero: { width: number; height: number };
  };
}): Promise<{
  artifact: {
    mode: ReproMode;
    sessionId: string;
    resizePayloads: ResizePayload[];
    outputSnapshotTail: string;
    sizeSamples: SizeSample[];
    screenshotPaths: {
      beforeZero: string;
      afterZero: string;
    };
    hostRects: {
      afterTiny: { width: number; height: number };
      afterZero: { width: number; height: number };
    };
    capture: {
      resizeWrapped: boolean;
      resizeWrapperProbeRecorded: boolean;
    };
  };
  tinyResizePayloads: ResizePayload[];
  tinyAfterSizeSamples: SizeSample[];
  tinySizeSamples: SizeSample[];
}> {
  const {
    page,
    electronApp,
    mode,
    sessionId,
    jsonPath,
    beforeScreenshotPath,
    afterScreenshotPath,
    hostRects,
  } = params;
  const capture = await getCaptureState(page, electronApp);
  const resizePayloads = capture.resizePayloads.filter((payload) => payload.sessionId === sessionId);
  const terminalOutput = capture.terminalOutput
    .filter((event) => event.sessionId === sessionId)
    .map((event) => event.data)
    .join('');
  const terminalList = await page.evaluate(() => window.invoker.planningTerminalList());
  const terminalDescriptor = terminalList.find((candidate) => candidate.sessionId === sessionId);
  const snapshotTail = outputTail(terminalDescriptor?.outputSnapshot ?? terminalOutput);
  const sizeSamples = parseSizeSamples(terminalOutput);
  const tinyResizePayloads = resizePayloads.filter(isTinyGeometry);
  const tinyAfterSizeSamples = sizeSamples.filter((sample) => sample.label === 'after' && isTinyGeometry(sample));
  const tinySizeSamples = sizeSamples.filter(isTinyGeometry);

  const artifact = {
    mode,
    sessionId,
    resizePayloads,
    outputSnapshotTail: snapshotTail,
    sizeSamples,
    screenshotPaths: {
      beforeZero: beforeScreenshotPath,
      afterZero: afterScreenshotPath,
    },
    hostRects,
    capture: {
      resizeWrapped: capture.resizeWrapped,
      resizeWrapperProbeRecorded: capture.resizeWrapperProbeRecorded,
    },
  };
  await writeFile(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');

  return { artifact, tinyResizePayloads, tinyAfterSizeSamples, tinySizeSamples };
}

async function verifyBridgeWrapper(page: Page, electronApp: ElectronApplication): Promise<void> {
  await page.evaluate(async () => {
    await window.invoker.planningTerminalResize('__planning_tmux_blank_repro_probe__', 80, 24);
  });
  await expect.poll(async () => (await getCaptureState(page, electronApp)).resizeWrapperProbeRecorded, {
    message: 'planningTerminalResize wrapper records a delegated probe call',
    timeout: 5000,
  }).toBe(true);
}

async function waitForZeroHost(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const host = document.querySelector<HTMLElement>('[data-testid="invoker-terminal-tmux-pane"]');
    if (!host) return false;
    const rect = host.getBoundingClientRect();
    return rect.width === 0 && rect.height === 0;
  }, null, { timeout: 5000 });
}

async function waitForTinyResizePayload(page: Page, electronApp: ElectronApplication, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const state = await getCaptureState(page, electronApp);
    return state.resizePayloads
      .filter((payload) => payload.sessionId === sessionId)
      .some(isTinyGeometry);
  }, {
    message: 'expected a tiny resize payload in before mode',
    timeout: 5000,
  }).toBe(true);
}

async function waitForTinyAfterSizeSample(page: Page, electronApp: ElectronApplication, sessionId: string): Promise<void> {
  await expect.poll(async () => {
    const state = await getCaptureState(page, electronApp);
    const terminalOutput = state.terminalOutput
      .filter((event) => event.sessionId === sessionId)
      .map((event) => event.data)
      .join('');
    return parseSizeSamples(terminalOutput)
      .some((sample) => sample.label === 'after' && isTinyGeometry(sample));
  }, {
    message: 'expected a tiny TMUX_SIZE after stty sample in before mode',
    timeout: 5000,
  }).toBe(true);
}

test.describe('planning tmux blank repro', () => {
  test('records resize IPC and live PTY geometry through a zero-size planning tmux host', async ({ page, electronApp }, testInfo) => {
    const mode = reproMode();
    const artifactDir = testInfo.outputPath('planning-tmux-blank-repro');
    await mkdir(artifactDir, { recursive: true });

    await installCaptureHooks(page, electronApp);
    await expect.poll(async () => (await getCaptureState(page, electronApp)).resizeWrapped, {
      message: 'planningTerminalResize wrapper installed',
      timeout: 5000,
    }).toBe(true);
    await verifyBridgeWrapper(page, electronApp);

    const sessionId = await openPlanningTmux(page);
    const beforeScreenshotPath = path.join(artifactDir, `planning-tmux-${mode}-before-zero.png`);
    const afterScreenshotPath = path.join(artifactDir, `planning-tmux-${mode}-after-zero.png`);
    const jsonPath = path.join(artifactDir, `planning-tmux-${mode}-artifact.json`);

    await writeSizeMarker(page, electronApp, sessionId, 'before');
    await waitForStableUI(page);
    await page.screenshot({ path: beforeScreenshotPath, fullPage: true });

    const hostRects = await forceZeroSizeHostTransition(page);
    await waitForZeroHost(page);

    if (mode === 'before') {
      await waitForTinyResizePayload(page, electronApp, sessionId);
    } else {
      await page.waitForTimeout(1000);
    }

    await writeSizeMarker(page, electronApp, sessionId, 'after');
    await waitForStableUI(page);
    await page.screenshot({ path: afterScreenshotPath, fullPage: true });

    if (mode === 'before') {
      await waitForTinyAfterSizeSample(page, electronApp, sessionId);
    }

    const { artifact, tinyResizePayloads, tinyAfterSizeSamples, tinySizeSamples } = await saveArtifacts({
      page,
      electronApp,
      mode,
      sessionId,
      jsonPath,
      beforeScreenshotPath,
      afterScreenshotPath,
      hostRects: {
        afterTiny: hostRects.afterTiny,
        afterZero: await readZeroHostRect(page),
      },
    });

    if (mode === 'before') {
      expect(tinyResizePayloads.length, 'before mode should record tiny resize IPC payloads').toBeGreaterThan(0);
      expect(tinyAfterSizeSamples.length, 'before mode should record tiny live PTY stty geometry after the zero-size transition').toBeGreaterThan(0);
      console.log(`BUG_REPRODUCED=${JSON.stringify({ ...artifact, jsonPath })}`);
      return;
    }

    expect(tinyResizePayloads, 'after mode should not send tiny resize IPC payloads').toEqual([]);
    expect(tinySizeSamples, 'after mode should not observe tiny live PTY stty geometry').toEqual([]);
    console.log(`FIX_VERIFIED=${JSON.stringify({ ...artifact, jsonPath })}`);
  });
});
