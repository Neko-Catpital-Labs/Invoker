import { writeFileSync } from 'node:fs';
import type { ElectronApplication, Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-app.js';

type ReproMode = 'before' | 'after';

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
};

type ReproArtifact = {
  mode: ReproMode;
  sessionId: string;
  resizePayloads: ResizePayload[];
  outputSnapshotTail: string;
  sttySizeSamples: SttySizeSample[];
  screenshotPaths: string[];
};

const MODE_ENV = 'INVOKER_PLANNING_TMUX_BLANK_EXPECT';
const TINY_ROWS = 5;
const TINY_COLS = 20;
const OUTPUT_TAIL_CHARS = 5000;

function reproMode(): ReproMode {
  const raw = process.env[MODE_ENV] ?? 'after';
  if (raw === 'before' || raw === 'after') return raw;
  throw new Error(`${MODE_ENV} must be "before" or "after"; received "${raw}"`);
}

function isTinyResize(payload: Pick<ResizePayload, 'cols' | 'rows'>): boolean {
  return payload.rows <= TINY_ROWS || payload.cols <= TINY_COLS;
}

function isTinySttySize(sample: Pick<SttySizeSample, 'cols' | 'rows'>): boolean {
  return sample.rows <= TINY_ROWS || sample.cols <= TINY_COLS;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g, '');
}

function parseSttySizeSamples(output: string): SttySizeSample[] {
  const normalized = stripAnsi(output).replace(/\r/g, '\n');
  const samples: SttySizeSample[] = [];
  const pattern = /TMUX_SIZE\s+(before|after)\s+(\d+)\s+(\d+)/g;
  for (const match of normalized.matchAll(pattern)) {
    const rows = Number(match[2]);
    const cols = Number(match[3]);
    if (!Number.isFinite(rows) || !Number.isFinite(cols)) continue;
    samples.push({
      label: match[1] as 'before' | 'after',
      rows,
      cols,
      raw: match[0],
    });
  }
  return samples;
}

async function openHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function installResizeRecorder(electronApp: ElectronApplication): Promise<void> {
  const installed = await electronApp.evaluate(({ ipcMain }) => {
    type RecorderGlobal = typeof globalThis & {
      __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
      __INVOKER_PLANNING_TMUX_BLANK_ORIGINAL_RESIZE_HANDLER__?: (
        event: unknown,
        sessionId: string,
        cols: number,
        rows: number,
      ) => unknown;
    };
    const recorderGlobal = globalThis as RecorderGlobal;
    const channel = 'invoker:planning-terminal-resize';
    // contextBridge exposes window.invoker as immutable, so record the same payloads at the IPC boundary.
    const invokeHandlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (
        event: unknown,
        sessionId: string,
        cols: number,
        rows: number,
      ) => unknown>;
    })._invokeHandlers;
    const original = recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_ORIGINAL_RESIZE_HANDLER__
      ?? invokeHandlers?.get(channel);
    if (!original) {
      return { ok: false, reason: `No IPC handler registered for ${channel}` };
    }

    recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ = [];
    recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_ORIGINAL_RESIZE_HANDLER__ = original;
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (event, sessionId: string, cols: number, rows: number) => {
      recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__?.push({
        sessionId: String(sessionId),
        cols: Number(cols),
        rows: Number(rows),
      });
      return original(event, sessionId, cols, rows);
    });

    return { ok: true };
  });
  expect(installed, 'planning terminal resize IPC recorder must be installed').toMatchObject({ ok: true });
}

async function getResizePayloads(electronApp: ElectronApplication): Promise<ResizePayload[]> {
  return electronApp.evaluate(() => {
    const recorderGlobal = globalThis as typeof globalThis & {
      __INVOKER_PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
    };
    return recorderGlobal.__INVOKER_PLANNING_TMUX_BLANK_RESIZES__ ?? [];
  });
}

async function openPlanningTmux(page: Page): Promise<string> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'Tmux' }).click();
  const pane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(pane).toBeVisible({ timeout: 10000 });
  const sessionId = await pane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  await expect.poll(async () => readOutputSnapshot(page, sessionId ?? ''), { timeout: 10000 }).toContain('Invoker planning tmux bridge');
  return sessionId ?? '';
}

async function readOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
}

async function writeSttyMarker(
  page: Page,
  sessionId: string,
  label: 'before' | 'after',
): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, markerLabel }) => {
    return window.invoker.planningTerminalWrite(
      targetSessionId,
      `printf 'TMUX_SIZE ${markerLabel} '; stty size\n`,
    );
  }, { targetSessionId: sessionId, markerLabel: label });
  expect(result).toMatchObject({ ok: true });
  await expect.poll(async () => {
    const output = await readOutputSnapshot(page, sessionId);
    return parseSttySizeSamples(output).some((sample) => sample.label === label);
  }, { timeout: 10000 }).toBe(true);
}

async function forceZeroSizeHost(page: Page): Promise<void> {
  const observedResize = await page.evaluate(async () => {
    const host = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    if (!host) throw new Error('planning tmux pane was not found');

    let resolveObserved: (value: boolean) => void = () => undefined;
    const observedPromise = new Promise<boolean>((resolve) => {
      resolveObserved = resolve;
    });
    let observer: ResizeObserver | null = null;
    const timeout = window.setTimeout(() => {
      observer?.disconnect();
      resolveObserved(false);
    }, 1000);

    observer = new ResizeObserver(() => {
      window.clearTimeout(timeout);
      observer?.disconnect();
      resolveObserved(true);
    });
    observer.observe(host);

    const style = document.createElement('style');
    style.setAttribute('data-testid', 'planning-tmux-zero-size-repro-style');
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

    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const observed = await observedPromise;
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    const rect = host.getBoundingClientRect();
    if (rect.width !== 0 || rect.height !== 0) {
      throw new Error(`planning tmux pane did not collapse to 0x0; got ${rect.width}x${rect.height}`);
    }
    return observed;
  });
  expect(observedResize, 'test ResizeObserver must observe the zero-size host transition').toBe(true);
  await page.waitForTimeout(250);
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  }).catch(() => undefined);
}

test.describe('Planning tmux blank geometry repro', () => {
  test('records resize IPC and live PTY geometry across a zero-size planning tmux host', async ({ electronApp, page }, testInfo) => {
    const mode = reproMode();
    const screenshotPaths: string[] = [];
    let sessionId = '';

    try {
      await openHome(page);
      await installResizeRecorder(electronApp);
      sessionId = await openPlanningTmux(page);

      const initialScreenshotPath = testInfo.outputPath(`planning-tmux-${mode}-initial.png`);
      await page.screenshot({ path: initialScreenshotPath, fullPage: true });
      screenshotPaths.push(initialScreenshotPath);
      await testInfo.attach('planning-tmux-initial', { path: initialScreenshotPath, contentType: 'image/png' });

      await writeSttyMarker(page, sessionId, 'before');
      await forceZeroSizeHost(page);

      if (mode === 'before') {
        await expect.poll(async () => {
          const payloads = await getResizePayloads(electronApp);
          return payloads.filter((payload) => payload.sessionId === sessionId && isTinyResize(payload)).length;
        }, { timeout: 10000 }).toBeGreaterThan(0);
        await page.waitForTimeout(250);
      }

      const zeroSizeScreenshotPath = testInfo.outputPath(`planning-tmux-${mode}-zero-size.png`);
      await page.screenshot({ path: zeroSizeScreenshotPath, fullPage: true });
      screenshotPaths.push(zeroSizeScreenshotPath);
      await testInfo.attach('planning-tmux-zero-size', { path: zeroSizeScreenshotPath, contentType: 'image/png' });

      await writeSttyMarker(page, sessionId, 'after');
      await page.waitForTimeout(500);

      const outputSnapshot = await readOutputSnapshot(page, sessionId);
      const artifact: ReproArtifact = {
        mode,
        sessionId,
        resizePayloads: await getResizePayloads(electronApp),
        outputSnapshotTail: outputSnapshot.slice(-OUTPUT_TAIL_CHARS),
        sttySizeSamples: parseSttySizeSamples(outputSnapshot),
        screenshotPaths,
      };
      const artifactPath = testInfo.outputPath(`planning-tmux-blank-${mode}.json`);
      writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
      await testInfo.attach('planning-tmux-blank-artifact', { path: artifactPath, contentType: 'application/json' });

      const sessionResizePayloads = artifact.resizePayloads.filter((payload) => payload.sessionId === sessionId);
      const tinyResizePayloads = sessionResizePayloads.filter(isTinyResize);
      const tinySttySamples = artifact.sttySizeSamples.filter(isTinySttySize);
      const tinyAfterSttySamples = artifact.sttySizeSamples.filter((sample) => sample.label === 'after' && isTinySttySize(sample));

      if (mode === 'before') {
        expect(tinyResizePayloads, 'before mode must observe a tiny planningTerminalResize payload').not.toEqual([]);
        expect(tinyAfterSttySamples, 'before mode must observe tiny live PTY geometry after host collapse').not.toEqual([]);
        console.log(`BUG_REPRODUCED=${JSON.stringify(artifact)}`);
      } else {
        expect(tinyResizePayloads, 'after mode must not send tiny planningTerminalResize payloads').toEqual([]);
        expect(tinySttySamples, 'after mode must not observe tiny live PTY stty samples').toEqual([]);
        console.log(`FIX_VERIFIED=${JSON.stringify(artifact)}`);
      }
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
