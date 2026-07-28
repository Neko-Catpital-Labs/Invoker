import { writeFileSync } from 'node:fs';
import type { ElectronApplication, Page, TestInfo } from '@playwright/test';
import { expect, test } from './fixtures/electron-app.js';

type ReproMode = 'before' | 'after';
type ResizeRecorderStrategy = 'page' | 'main-ipc';

type ResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
};

type SttySizeSample = {
  label: 'before' | 'after';
  rows: number;
  cols: number;
  raw: string;
  tiny: boolean;
};

type ReproArtifact = {
  mode: ReproMode;
  sessionId: string;
  resizeRecorderStrategy: ResizeRecorderStrategy;
  resizePayloads: ResizePayload[];
  outputSnapshotTail: string;
  sttySizeSamples: SttySizeSample[];
  screenshotPaths: {
    before: string;
    after: string;
  };
};

const MODE = parseMode(process.env.INVOKER_PLANNING_TMUX_BLANK_EXPECT);
const TINY_ROW_LIMIT = 5;
const TINY_COL_LIMIT = 20;
const RESIZE_IPC_CHANNEL = 'invoker:planning-terminal-resize';

function parseMode(value: string | undefined): ReproMode {
  if (value === undefined || value === '') return 'after';
  if (value === 'before' || value === 'after') return value;
  throw new Error(`INVOKER_PLANNING_TMUX_BLANK_EXPECT must be "before" or "after", got "${value}".`);
}

function isTinyGeometry(size: Pick<ResizePayload, 'cols' | 'rows'>): boolean {
  return size.rows <= TINY_ROW_LIMIT || size.cols <= TINY_COL_LIMIT;
}

function stripAnsi(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseSttySizeSamples(outputSnapshot: string): SttySizeSample[] {
  const cleaned = stripAnsi(outputSnapshot).replace(/\r/g, '');
  const samples: SttySizeSample[] = [];
  const pattern = /TMUX_SIZE\s+(before|after)\s+(\d+)\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(cleaned)) !== null) {
    const rows = Number(match[2]);
    const cols = Number(match[3]);
    samples.push({
      label: match[1] as 'before' | 'after',
      rows,
      cols,
      raw: match[0],
      tiny: isTinyGeometry({ rows, cols }),
    });
  }
  return samples;
}

async function openHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function switchPlanningTerminalToTmux(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: /tmux/i }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect.poll(async () => readOutputSnapshot(page, sessionId ?? ''), { timeout: 10000 }).toContain('Invoker planning tmux bridge');
  return sessionId ?? '';
}

async function installResizeRecorder(page: Page, electronApp: ElectronApplication): Promise<ResizeRecorderStrategy> {
  const pageResult = await page.evaluate(() => {
    const targetWindow = window as Window & {
      __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
      __INVOKER_PLANNING_TMUX_BLANK_ORIGINAL_RESIZE__?: Window['invoker']['planningTerminalResize'];
    };
    const originalApi = window.invoker;
    const original = originalApi.planningTerminalResize;
    if (typeof original !== 'function') return { installed: false, strategy: 'missing-method' };
    targetWindow.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ = [];
    targetWindow.__INVOKER_PLANNING_TMUX_BLANK_ORIGINAL_RESIZE__ = original;
    const wrapped = async (sessionId: string, cols: number, rows: number) => {
      targetWindow.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__?.push({ sessionId, cols, rows });
      return original.call(originalApi, sessionId, cols, rows);
    };
    try {
      window.invoker.planningTerminalResize = wrapped;
      if (window.invoker.planningTerminalResize !== original) return { installed: true, strategy: 'method' };
    } catch {
      /* contextBridge freezes nested API members; fall back to replacing the top-level bridge. */
    }

    const windowDescriptor = Object.getOwnPropertyDescriptor(window, 'invoker');
    const replacement = new Proxy(originalApi, {
      get(target, prop, receiver) {
        if (prop === 'planningTerminalResize') return wrapped;
        return Reflect.get(target, prop, receiver);
      },
    }) as Window['invoker'];
    try {
      if (!windowDescriptor || windowDescriptor.configurable) {
        Object.defineProperty(window, 'invoker', {
          configurable: windowDescriptor?.configurable ?? true,
          enumerable: windowDescriptor?.enumerable ?? true,
          writable: true,
          value: replacement,
        });
      } else if (windowDescriptor.writable) {
        window.invoker = replacement;
      }
    } catch {
      return {
        installed: false,
        strategy: 'failed',
        windowDescriptor: windowDescriptor
          ? {
              configurable: windowDescriptor.configurable,
              enumerable: windowDescriptor.enumerable,
              writable: windowDescriptor.writable,
            }
          : null,
        invokerFrozen: Object.isFrozen(originalApi),
      };
    }

    return {
      installed: window.invoker.planningTerminalResize !== original,
      strategy: 'window-proxy',
      windowDescriptor: windowDescriptor
        ? {
            configurable: windowDescriptor.configurable,
            enumerable: windowDescriptor.enumerable,
            writable: windowDescriptor.writable,
          }
        : null,
      invokerFrozen: Object.isFrozen(originalApi),
    };
  });
  if (pageResult.installed) return 'page';

  const mainResult = await electronApp.evaluate(({ ipcMain }, channel) => {
    const handlers = (ipcMain as unknown as { _invokeHandlers?: Map<string, unknown> })._invokeHandlers;
    if (!(handlers instanceof Map)) {
      return { installed: false, reason: 'ipcMain invoke handler map was not available' };
    }
    const original = handlers.get(channel);
    if (typeof original !== 'function') {
      return { installed: false, reason: `no invoke handler registered for ${channel}` };
    }
    const recorderGlobal = globalThis as typeof globalThis & {
      __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
    };
    recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ = [];
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, sessionId: string, cols: number, rows: number) => {
      recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__?.push({ sessionId, cols, rows });
      return original(event, sessionId, cols, rows);
    });
    return { installed: true };
  }, RESIZE_IPC_CHANNEL);

  expect(
    mainResult.installed,
    `planningTerminalResize must be wrapped so the repro records IPC payloads: ${JSON.stringify({ pageResult, mainResult })}`,
  ).toBe(true);
  return 'main-ipc';
}

async function resizePayloads(
  page: Page,
  electronApp: ElectronApplication,
  strategy: ResizeRecorderStrategy,
): Promise<ResizePayload[]> {
  if (strategy === 'main-ipc') {
    return electronApp.evaluate(() => {
      const recorderGlobal = globalThis as typeof globalThis & {
        __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
      };
      return recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ ?? [];
    });
  }
  return page.evaluate(() => {
    const targetWindow = window as Window & {
      __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
    };
    return targetWindow.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ ?? [];
  });
}

async function readOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
}

async function writePlanningTerminalCommand(page: Page, sessionId: string, command: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, data }) => {
    return window.invoker.planningTerminalWrite(targetSessionId, data);
  }, { targetSessionId: sessionId, data: `${command}\n` });
  expect(result).toMatchObject({ ok: true });
}

async function waitForSttySample(page: Page, sessionId: string, label: 'before' | 'after'): Promise<void> {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const snapshot = await readOutputSnapshot(page, sessionId);
    const samples = parseSttySizeSamples(snapshot);
    if (samples.some((sample) => sample.label === label)) return;
    await page.waitForTimeout(250);
  }
}

async function waitForTinyResizePayload(
  page: Page,
  electronApp: ElectronApplication,
  strategy: ResizeRecorderStrategy,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const payloads = await resizePayloads(page, electronApp, strategy);
    if (payloads.some((payload) => payload.sessionId === sessionId && isTinyGeometry(payload))) return;
    await page.waitForTimeout(100);
  }
}

async function forceZeroSizedTmuxHost(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pane = document.querySelector<HTMLElement>('[data-testid="invoker-terminal-tmux-pane"]');
    if (!pane) throw new Error('planning tmux pane was not mounted');

    let resizeObserved = false;
    const resizeObservedPromise = new Promise<void>((resolve) => {
      const observer = new ResizeObserver(() => {
        resizeObserved = true;
        observer.disconnect();
        requestAnimationFrame(() => resolve());
      });
      observer.observe(pane);
      setTimeout(() => {
        if (!resizeObserved) {
          observer.disconnect();
          resolve();
        }
      }, 500);
    });

    const style = document.createElement('style');
    style.setAttribute('data-invoker-planning-tmux-blank-repro', 'zero-host');
    style.textContent = `
      [data-testid="invoker-terminal-tmux-pane"] {
        bottom: auto !important;
        height: 0 !important;
        max-height: 0 !important;
        max-width: 0 !important;
        min-height: 0 !important;
        min-width: 0 !important;
        overflow: hidden !important;
        right: auto !important;
        width: 0 !important;
      }
    `;
    document.head.appendChild(style);
    void pane.getBoundingClientRect();

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    await resizeObservedPromise;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
}

async function screenshot(page: Page, testInfo: TestInfo, name: string): Promise<string> {
  const screenshotPath = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach(`${name}-screenshot`, { path: screenshotPath, contentType: 'image/png' });
  return screenshotPath;
}

async function buildArtifact(
  page: Page,
  electronApp: ElectronApplication,
  testInfo: TestInfo,
  mode: ReproMode,
  sessionId: string,
  resizeRecorderStrategy: ResizeRecorderStrategy,
  screenshotPaths: ReproArtifact['screenshotPaths'],
): Promise<ReproArtifact> {
  const outputSnapshot = await readOutputSnapshot(page, sessionId);
  const artifact: ReproArtifact = {
    mode,
    sessionId,
    resizeRecorderStrategy,
    resizePayloads: await resizePayloads(page, electronApp, resizeRecorderStrategy),
    outputSnapshotTail: stripAnsi(outputSnapshot).slice(-8000),
    sttySizeSamples: parseSttySizeSamples(outputSnapshot),
    screenshotPaths,
  };
  const artifactPath = testInfo.outputPath(`planning-tmux-blank-${mode}.json`);
  writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
  await testInfo.attach(`planning-tmux-blank-${mode}`, {
    path: artifactPath,
    contentType: 'application/json',
  });
  return artifact;
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  }).catch(() => undefined);
}

test.describe('Planning tmux blank geometry repro', () => {
  test('checks planning tmux resize IPC and PTY geometry during a zero-size host transition', async ({ electronApp, page }, testInfo) => {
    let artifact: ReproArtifact | null = null;
    let sessionId = '';
    let resizeRecorderStrategy: ResizeRecorderStrategy = 'page';
    try {
      await openHome(page);
      sessionId = await switchPlanningTerminalToTmux(page);
      resizeRecorderStrategy = await installResizeRecorder(page, electronApp);

      await writePlanningTerminalCommand(page, sessionId, "printf 'TMUX_SIZE before '; stty size");
      await waitForSttySample(page, sessionId, 'before');
      const beforeScreenshotPath = await screenshot(page, testInfo, 'planning-tmux-before-zero-host');

      await forceZeroSizedTmuxHost(page);
      if (MODE === 'before') {
        await waitForTinyResizePayload(page, electronApp, resizeRecorderStrategy, sessionId);
      } else {
        await page.waitForTimeout(750);
      }

      await writePlanningTerminalCommand(page, sessionId, "printf 'TMUX_SIZE after '; stty size");
      await waitForSttySample(page, sessionId, 'after');
      const afterScreenshotPath = await screenshot(page, testInfo, 'planning-tmux-after-zero-host');

      artifact = await buildArtifact(page, electronApp, testInfo, MODE, sessionId, resizeRecorderStrategy, {
        before: beforeScreenshotPath,
        after: afterScreenshotPath,
      });

      const relevantResizePayloads = artifact.resizePayloads.filter((payload) => payload.sessionId === sessionId);
      const tinyResizePayloads = relevantResizePayloads.filter(isTinyGeometry);
      const beforeSamples = artifact.sttySizeSamples.filter((sample) => sample.label === 'before');
      const afterSamples = artifact.sttySizeSamples.filter((sample) => sample.label === 'after');
      const tinySttySamples = artifact.sttySizeSamples.filter((sample) => sample.tiny);
      const artifactJson = JSON.stringify(artifact);

      expect(beforeSamples.length, artifactJson).toBeGreaterThan(0);
      expect(afterSamples.length, artifactJson).toBeGreaterThan(0);

      if (MODE === 'before') {
        expect(relevantResizePayloads.length, artifactJson).toBeGreaterThan(0);
        expect(tinyResizePayloads.length, artifactJson).toBeGreaterThan(0);
        expect(afterSamples.some((sample) => sample.tiny), artifactJson).toBe(true);
        console.log(`BUG_REPRODUCED=${artifactJson}`);
      } else {
        expect(tinyResizePayloads, artifactJson).toHaveLength(0);
        expect(tinySttySamples, artifactJson).toHaveLength(0);
        console.log(`FIX_VERIFIED=${artifactJson}`);
      }
    } finally {
      await closePlanningTerminalSessions(page);
      if (!artifact && sessionId) {
        const fallbackScreenshotPath = await screenshot(page, testInfo, 'planning-tmux-fallback-evidence').catch(() => '');
        await buildArtifact(page, electronApp, testInfo, MODE, sessionId, resizeRecorderStrategy, {
          before: fallbackScreenshotPath,
          after: fallbackScreenshotPath,
        }).catch(() => undefined);
      }
    }
  });
});
