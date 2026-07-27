import { expect, test } from './fixtures/electron-app.js';
import type { ElectronApplication, Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

type ReproMode = 'before' | 'after';

type ResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
};

type SttySizeSample = {
  phase: 'before' | 'after';
  rows: number;
  cols: number;
};

type ReproArtifact = {
  mode: ReproMode;
  sessionId: string;
  resizePayloads: ResizePayload[];
  outputSnapshotTail: string;
  sttySizeSamples: SttySizeSample[];
  screenshotPaths: {
    before: string;
    after: string;
  };
};

type BrowserWindowWithReproState = Window & {
  __PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
};

type MainProcessWithReproState = typeof globalThis & {
  __PLANNING_TMUX_BLANK_RESIZES__?: ResizePayload[];
};

const REPRO_MODE = parseReproMode(process.env.INVOKER_PLANNING_TMUX_BLANK_EXPECT);
const TINY_ROWS = 5;
const TINY_COLS = 20;

function parseReproMode(rawMode: string | undefined): ReproMode {
  if (!rawMode || rawMode === 'after') return 'after';
  if (rawMode === 'before') return 'before';
  throw new Error(`INVOKER_PLANNING_TMUX_BLANK_EXPECT must be "before" or "after"; received "${rawMode}".`);
}

function isTinyGeometry(value: Pick<ResizePayload, 'cols' | 'rows'>): boolean {
  return value.rows <= TINY_ROWS || value.cols <= TINY_COLS;
}

function parseSttySizeSamples(text: string): SttySizeSample[] {
  const samples: SttySizeSample[] = [];
  const pattern = /TMUX_SIZE (before|after)\s+(\d+)\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    samples.push({
      phase: match[1] as 'before' | 'after',
      rows: Number(match[2]),
      cols: Number(match[3]),
    });
  }
  return samples;
}

function artifactPath(name: string, fallbackPath: string): string {
  const artifactDir = process.env.INVOKER_PLANNING_TMUX_BLANK_ARTIFACT_DIR;
  if (!artifactDir) return fallbackPath;
  mkdirSync(artifactDir, { recursive: true });
  return path.join(artifactDir, name);
}

async function getPlanningOutputSnapshot(page: Page, terminalSessionId: string): Promise<string> {
  return page.evaluate(async (sessionId) => {
    const [terminalSessions, chatSessions] = await Promise.all([
      window.invoker.planningTerminalList(),
      window.invoker.planningChatList(),
    ]);
    const terminalSnapshot = terminalSessions.find((session) => session.sessionId === sessionId)?.outputSnapshot;
    if (terminalSnapshot) return terminalSnapshot;
    if (!chatSessions.ok) return '';
    return chatSessions.sessions.find((session) => session.terminalSessionId === sessionId)?.terminalOutputSnapshot ?? '';
  }, terminalSessionId);
}

async function writePlanningTerminalCommand(
  page: Page,
  terminalSessionId: string,
  command: string,
): Promise<void> {
  const result = await page.evaluate(
    async ({ sessionId, data }) => window.invoker.planningTerminalWrite(sessionId, data),
    { sessionId: terminalSessionId, data: command },
  );
  expect(result).toEqual({ ok: true });
}

async function writeSttySample(
  page: Page,
  terminalSessionId: string,
  phase: 'before' | 'after',
): Promise<SttySizeSample[]> {
  await writePlanningTerminalCommand(
    page,
    terminalSessionId,
    `printf 'TMUX_SIZE ${phase} '; stty size\n`,
  );
  await expect.poll(async () => {
    const output = await getPlanningOutputSnapshot(page, terminalSessionId);
    return parseSttySizeSamples(output).some((sample) => sample.phase === phase);
  }, {
    message: `waiting for TMUX_SIZE ${phase} stty sample`,
    timeout: 10_000,
  }).toBe(true);
  const output = await getPlanningOutputSnapshot(page, terminalSessionId);
  return parseSttySizeSamples(output);
}

async function forceZeroSizeHostTransition(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]') as HTMLElement | null;
    if (!pane) throw new Error('Planning tmux pane not found.');

    await new Promise<void>((resolve) => {
      let settled = false;
      let observer: ResizeObserver | null = null;
      const finish = () => {
        if (settled) return;
        settled = true;
        observer?.disconnect();
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      };

      observer = new ResizeObserver(() => finish());
      observer.observe(pane);

      const style = document.createElement('style');
      style.setAttribute('data-testid', 'planning-tmux-zero-size-repro-style');
      style.textContent = `
        [data-testid="invoker-terminal-tmux-pane"] {
          bottom: auto !important;
          display: block !important;
          height: 0 !important;
          left: 0 !important;
          max-height: 0 !important;
          max-width: 0 !important;
          min-height: 0 !important;
          min-width: 0 !important;
          overflow: hidden !important;
          right: auto !important;
          top: 0 !important;
          width: 0 !important;
        }
      `;
      document.head.appendChild(style);
      setTimeout(finish, 500);
    });
  });
}

async function installResizeRecorder(page: Page, electronApp: ElectronApplication): Promise<void> {
  await page.evaluate(() => {
    const win = window as BrowserWindowWithReproState;
    win.__PLANNING_TMUX_BLANK_RESIZES__ = [];
    const originalInvoker = window.invoker;
    const originalResize = originalInvoker.planningTerminalResize.bind(originalInvoker);
    const replacementResize = async (sessionId: string, cols: number, rows: number) => {
      win.__PLANNING_TMUX_BLANK_RESIZES__?.push({ sessionId, cols, rows });
      return originalResize(sessionId, cols, rows);
    };
    try {
      window.invoker.planningTerminalResize = replacementResize;
    } catch {
      /* Electron may expose context-bridged methods as read-only proxies. */
    }
    if (window.invoker.planningTerminalResize === replacementResize) return;
    try {
      Object.defineProperty(window, 'invoker', {
        configurable: true,
        value: new Proxy(originalInvoker, {
          get(target, prop, receiver) {
            if (prop === 'planningTerminalResize') return replacementResize;
            return Reflect.get(target, prop, receiver);
          },
        }),
      });
    } catch {
      win.__PLANNING_TMUX_BLANK_RESIZES__ = [];
    }
  });

  await electronApp.evaluate(({ ipcMain }) => {
    const globalState = globalThis as MainProcessWithReproState;
    globalState.__PLANNING_TMUX_BLANK_RESIZES__ = [];
    const channel = 'invoker:planning-terminal-resize';
    const ipcMainWithHandlers = ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...args: unknown[]) => unknown>;
      __planningTmuxBlankOriginalResizeHandler?: (...args: unknown[]) => unknown;
    };
    const handlers = ipcMainWithHandlers._invokeHandlers;
    const original = ipcMainWithHandlers.__planningTmuxBlankOriginalResizeHandler
      ?? handlers?.get(channel);
    if (!handlers || typeof original !== 'function') {
      throw new Error('Unable to locate planning-terminal-resize IPC handler for repro recording.');
    }
    ipcMainWithHandlers.__planningTmuxBlankOriginalResizeHandler = original;
    handlers.set(channel, async (...args: unknown[]) => {
      const [, rawSessionId, rawCols, rawRows] = args;
      globalState.__PLANNING_TMUX_BLANK_RESIZES__?.push({
        sessionId: String(rawSessionId),
        cols: Number(rawCols),
        rows: Number(rawRows),
      });
      return original(...args);
    });
  });
}

async function readResizePayloads(page: Page, electronApp: ElectronApplication): Promise<ResizePayload[]> {
  const rendererPayloads = await page.evaluate(() => {
    const win = window as BrowserWindowWithReproState;
    return [...(win.__PLANNING_TMUX_BLANK_RESIZES__ ?? [])];
  });
  const mainPayloads = await electronApp.evaluate(() => {
    const globalState = globalThis as MainProcessWithReproState;
    return [...(globalState.__PLANNING_TMUX_BLANK_RESIZES__ ?? [])];
  });
  return rendererPayloads.length > 0 ? rendererPayloads : mainPayloads;
}

test.describe('planning tmux zero-size resize repro', () => {
  test('records resize IPC and live PTY geometry during zero-size host transition', async ({ page, electronApp }, testInfo) => {
    await page.getByTestId('sidebar-home').click();
    await expect(page.getByTestId('invoker-terminal-mode-toggle')).toBeVisible({ timeout: 10_000 });
    await installResizeRecorder(page, electronApp);

    await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
    const pane = page.getByTestId('invoker-terminal-tmux-pane');
    await expect(pane).toBeVisible({ timeout: 10_000 });
    const terminalSessionId = await pane.getAttribute('data-session-id');
    expect(terminalSessionId).toBeTruthy();

    await expect.poll(async () => {
      const sessions = await page.evaluate(() => window.invoker.planningTerminalList());
      return sessions.find((session) => session.sessionId === terminalSessionId)?.status ?? null;
    }, { timeout: 10_000 }).toBe('running');

    const beforeScreenshotPath = artifactPath(
      'planning-tmux-blank-before.png',
      testInfo.outputPath('planning-tmux-blank-before.png'),
    );
    const afterScreenshotPath = artifactPath(
      'planning-tmux-blank-after.png',
      testInfo.outputPath('planning-tmux-blank-after.png'),
    );
    const jsonPath = artifactPath(
      'planning-tmux-blank-repro.json',
      testInfo.outputPath('planning-tmux-blank-repro.json'),
    );

    await writeSttySample(page, terminalSessionId ?? '', 'before');
    await page.screenshot({ path: beforeScreenshotPath, fullPage: true });

    await forceZeroSizeHostTransition(page);
    await writeSttySample(page, terminalSessionId ?? '', 'after');
    await page.screenshot({ path: afterScreenshotPath, fullPage: true });

    const outputSnapshot = await getPlanningOutputSnapshot(page, terminalSessionId ?? '');
    const artifact: ReproArtifact = {
      mode: REPRO_MODE,
      sessionId: terminalSessionId ?? '',
      resizePayloads: await readResizePayloads(page, electronApp),
      outputSnapshotTail: outputSnapshot.slice(-1_000),
      sttySizeSamples: parseSttySizeSamples(outputSnapshot),
      screenshotPaths: {
        before: beforeScreenshotPath,
        after: afterScreenshotPath,
      },
    };
    writeFileSync(jsonPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
    await testInfo.attach('planning-tmux-blank-repro-json', {
      path: jsonPath,
      contentType: 'application/json',
    });
    await testInfo.attach('planning-tmux-blank-before-screenshot', {
      path: beforeScreenshotPath,
      contentType: 'image/png',
    });
    await testInfo.attach('planning-tmux-blank-after-screenshot', {
      path: afterScreenshotPath,
      contentType: 'image/png',
    });

    const tinyResizePayloads = artifact.resizePayloads
      .filter((payload) => payload.sessionId === artifact.sessionId)
      .filter(isTinyGeometry);
    const tinySttySamples = artifact.sttySizeSamples.filter(isTinyGeometry);
    const marker = REPRO_MODE === 'before' ? 'BUG_REPRODUCED' : 'FIX_VERIFIED';
    console.log(`${marker}=${JSON.stringify(artifact)}`);

    if (REPRO_MODE === 'before') {
      expect(tinyResizePayloads, JSON.stringify(artifact)).not.toHaveLength(0);
      expect(
        artifact.sttySizeSamples.some((sample) => sample.phase === 'after' && isTinyGeometry(sample)),
        JSON.stringify(artifact),
      ).toBe(true);
    } else {
      expect(tinyResizePayloads, JSON.stringify(artifact)).toHaveLength(0);
      expect(tinySttySamples, JSON.stringify(artifact)).toHaveLength(0);
    }

    await page.evaluate(async () => {
      const sessions = await window.invoker.planningTerminalList();
      await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
    }).catch(() => undefined);
  });
});
