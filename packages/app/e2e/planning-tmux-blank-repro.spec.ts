import { expect, test } from './fixtures/electron-app.js';
import type { ElectronApplication, Page } from '@playwright/test';
import * as fs from 'node:fs/promises';

type ReproMode = 'before' | 'after';

type ResizePayload = {
  sessionId: string;
  cols: number;
  rows: number;
  at: number;
  source?: string;
};

type SttySizeSample = {
  label: string;
  rows: number;
  cols: number;
};

const mode = normalizeMode(process.env.INVOKER_PLANNING_TMUX_BLANK_EXPECT);

function normalizeMode(value: string | undefined): ReproMode {
  if (!value || value === 'after') return 'after';
  if (value === 'before') return 'before';
  throw new Error(`INVOKER_PLANNING_TMUX_BLANK_EXPECT must be "before" or "after", got "${value}".`);
}

function isTinyGeometry(sample: { rows: number; cols: number }): boolean {
  return sample.rows <= 5 || sample.cols <= 20;
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
}

function parseSttySizeSamples(output: string): SttySizeSample[] {
  const samples: SttySizeSample[] = [];
  const clean = stripAnsi(output).replace(/\r/g, '\n');
  const pattern = /TMUX_SIZE\s+(before|after)\s+(\d+)\s+(\d+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(clean)) !== null) {
    samples.push({
      label: match[1] ?? '',
      rows: Number(match[2]),
      cols: Number(match[3]),
    });
  }
  return samples;
}

async function installResizeRecorder(page: Page): Promise<void> {
  await page.evaluate(() => {
    const targetWindow = window as unknown as {
      invoker: {
        planningTerminalResize: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
      };
      __planningTmuxBlankResizePayloads?: ResizePayload[];
      __planningTmuxBlankOriginalResize?: (sessionId: string, cols: number, rows: number) => Promise<unknown>;
      __planningTmuxBlankRecorderInstall?: Record<string, unknown>;
    };
    targetWindow.__planningTmuxBlankResizePayloads = [];
    const originalInvoker = targetWindow.invoker;
    const original = originalInvoker.planningTerminalResize.bind(originalInvoker);
    targetWindow.__planningTmuxBlankOriginalResize = original;
    const wrappedResize = async (sessionId: string, cols: number, rows: number) => {
      try {
        return await original(sessionId, cols, rows);
      } finally {
        targetWindow.__planningTmuxBlankResizePayloads?.push({
          sessionId,
          cols: Number(cols),
          rows: Number(rows),
          at: Date.now(),
        });
      }
    };
    try {
      originalInvoker.planningTerminalResize = wrappedResize;
    } catch {
      /* Electron contextBridge may freeze the exposed object. */
    }
    let installMode = 'direct';
    if (originalInvoker.planningTerminalResize !== wrappedResize) {
      installMode = 'window-wrapper';
      const wrappedInvoker = Object.create(originalInvoker) as typeof originalInvoker;
      Object.defineProperty(wrappedInvoker, 'planningTerminalResize', {
        value: wrappedResize,
        configurable: true,
        enumerable: true,
        writable: true,
      });
      try {
        Object.defineProperty(targetWindow, 'invoker', {
          value: wrappedInvoker,
          configurable: true,
          enumerable: true,
          writable: true,
        });
      } catch {
        targetWindow.invoker = wrappedInvoker;
      }
    }
    targetWindow.__planningTmuxBlankRecorderInstall = {
      installMode,
      invokerWrapped: targetWindow.invoker.planningTerminalResize === wrappedResize,
      originalFrozen: Object.isFrozen(originalInvoker),
    };
  });
}

async function installMainIpcResizeRecorder(electronApp: ElectronApplication): Promise<void> {
  await electronApp.evaluate(({ ipcMain }) => {
    const channel = 'invoker:planning-terminal-resize';
    const targetGlobal = globalThis as unknown as {
      __planningTmuxBlankMainResizePayloads?: ResizePayload[];
      __planningTmuxBlankMainResizeRecorderInstall?: Record<string, unknown>;
      __planningTmuxBlankOriginalMainResizeHandler?: (...args: unknown[]) => Promise<unknown>;
    };
    targetGlobal.__planningTmuxBlankMainResizePayloads = [];
    const handlers = (ipcMain as unknown as {
      _invokeHandlers?: Map<string, (...args: unknown[]) => Promise<unknown>>;
    })._invokeHandlers;
    const original = targetGlobal.__planningTmuxBlankOriginalMainResizeHandler ?? handlers?.get(channel);
    if (!handlers || typeof handlers.get !== 'function' || typeof handlers.set !== 'function') {
      throw new Error('Electron ipcMain invoke handler map is not available.');
    }
    if (typeof original !== 'function') {
      throw new Error(`Electron ipcMain handler for ${channel} is not available.`);
    }
    targetGlobal.__planningTmuxBlankOriginalMainResizeHandler = original;
    handlers.set(channel, async (event: unknown, sessionId: unknown, cols: unknown, rows: unknown) => {
      try {
        return await original(event, sessionId, cols, rows);
      } finally {
        targetGlobal.__planningTmuxBlankMainResizePayloads?.push({
          sessionId: String(sessionId),
          cols: Number(cols),
          rows: Number(rows),
          at: Date.now(),
          source: 'main-ipc',
        });
      }
    });
    targetGlobal.__planningTmuxBlankMainResizeRecorderInstall = {
      channel,
      installed: true,
      handlerCount: handlers.size,
    };
  });
}

async function installOutputRecorder(
  page: Page,
  sessionId: string,
): Promise<void> {
  await page.evaluate((targetSessionId) => {
    const targetWindow = window as unknown as {
      invoker: {
        onTerminalOutput: (cb: (event: { sessionId: string; data: string }) => void) => () => void;
      };
      __planningTmuxBlankOutput?: string;
      __planningTmuxBlankUnsubscribeOutput?: () => void;
    };
    targetWindow.__planningTmuxBlankUnsubscribeOutput?.();
    targetWindow.__planningTmuxBlankOutput = '';
    targetWindow.__planningTmuxBlankUnsubscribeOutput = targetWindow.invoker.onTerminalOutput((event) => {
      if (event.sessionId !== targetSessionId) return;
      targetWindow.__planningTmuxBlankOutput = `${targetWindow.__planningTmuxBlankOutput ?? ''}${event.data}`;
    });
  }, sessionId);
}

async function terminalEvidence(
  page: Page,
  sessionId: string,
): Promise<{ output: string; outputSnapshot: string }> {
  return page.evaluate(async (targetSessionId) => {
    const targetWindow = window as unknown as {
      invoker: {
        planningTerminalList: () => Promise<Array<{ sessionId: string; outputSnapshot?: string }>>;
      };
      __planningTmuxBlankOutput?: string;
    };
    const sessions = await targetWindow.invoker.planningTerminalList();
    const session = sessions.find((candidate) => candidate.sessionId === targetSessionId);
    const outputSnapshot = session?.outputSnapshot ?? '';
    return {
      output: `${outputSnapshot}${targetWindow.__planningTmuxBlankOutput ?? ''}`,
      outputSnapshot,
    };
  }, sessionId);
}

async function waitForSttySample(
  page: Page,
  sessionId: string,
  label: 'before' | 'after',
): Promise<void> {
  await expect.poll(async () => {
    const evidence = await terminalEvidence(page, sessionId);
    return parseSttySizeSamples(evidence.output).some((sample) => sample.label === label);
  }, {
    message: `wait for TMUX_SIZE ${label} marker`,
    timeout: 10_000,
  }).toBe(true);
}

async function resizePayloads(
  page: Page,
): Promise<ResizePayload[]> {
  return page.evaluate(() => {
    const targetWindow = window as unknown as { __planningTmuxBlankResizePayloads?: ResizePayload[] };
    return targetWindow.__planningTmuxBlankResizePayloads ?? [];
  });
}

async function mainIpcResizePayloads(electronApp: ElectronApplication): Promise<ResizePayload[]> {
  return electronApp.evaluate(() => {
    const targetGlobal = globalThis as unknown as { __planningTmuxBlankMainResizePayloads?: ResizePayload[] };
    return targetGlobal.__planningTmuxBlankMainResizePayloads ?? [];
  });
}

async function recordedResizePayloads(page: Page, electronApp: ElectronApplication): Promise<ResizePayload[]> {
  const [pagePayloads, mainPayloads] = await Promise.all([
    resizePayloads(page),
    mainIpcResizePayloads(electronApp),
  ]);
  return [...pagePayloads, ...mainPayloads];
}

async function writeTerminalCommand(
  page: Page,
  sessionId: string,
  command: string,
): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, commandText }) => {
    const targetWindow = window as unknown as {
      invoker: {
        planningTerminalWrite: (sessionId: string, data: string) => Promise<{ ok: boolean; reason?: string }>;
      };
    };
    return targetWindow.invoker.planningTerminalWrite(targetSessionId, `${commandText}\r`);
  }, { targetSessionId: sessionId, commandText: command });
  expect(result).toMatchObject({ ok: true });
}

async function forceZeroSizeTmuxHost(
  page: Page,
): Promise<void> {
  const zeroSizeResizeObserverTurn = page.evaluate(() => new Promise<{ width: number; height: number }>((resolve, reject) => {
    const host = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    if (!(host instanceof HTMLElement)) {
      reject(new Error('Planning tmux pane host was not found.'));
      return;
    }
    let settled = false;
    const finish = (width: number, height: number): void => {
      if (settled) return;
      if (width > 1 || height > 1) return;
      settled = true;
      observer.disconnect();
      resolve({ width, height });
    };
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      finish(rect.width, rect.height);
    });
    observer.observe(host);
    setTimeout(() => {
      const rect = host.getBoundingClientRect();
      if (rect.width <= 1 && rect.height <= 1) {
        finish(rect.width, rect.height);
      } else if (!settled) {
        settled = true;
        observer.disconnect();
        reject(new Error(`Planning tmux pane did not reach zero size: ${rect.width}x${rect.height}.`));
      }
    }, 5_000);
  }));

  await page.addStyleTag({
    content: `
      [data-testid="invoker-terminal-tmux-pane"] {
        inset: 0 auto auto 0 !important;
        width: 0 !important;
        height: 0 !important;
        min-width: 0 !important;
        min-height: 0 !important;
        max-width: 0 !important;
        max-height: 0 !important;
        padding: 0 !important;
        border: 0 !important;
        overflow: hidden !important;
      }
    `,
  });

  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
  await zeroSizeResizeObserverTurn;
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 0)));
  }));
}

test('planning tmux zero-size host resize evidence', async ({ electronApp, page }, testInfo) => {
  const screenshotBefore = testInfo.outputPath(`planning-tmux-blank-${mode}-before.png`);
  const screenshotAfter = testInfo.outputPath(`planning-tmux-blank-${mode}-after.png`);
  const artifactPath = testInfo.outputPath(`planning-tmux-blank-${mode}.json`);

  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-mode-toggle')).toBeVisible({ timeout: 10_000 });

  await installResizeRecorder(page);
  await installMainIpcResizeRecorder(electronApp);

  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: 'tmux' }).click();
  const tmuxPane = page.getByTestId('invoker-terminal-tmux-pane');
  await expect(tmuxPane).toBeVisible({ timeout: 10_000 });
  const sessionId = await tmuxPane.getAttribute('data-session-id');
  expect(sessionId).toBeTruthy();
  const planningSessionId = await page.evaluate(async (terminalSessionId) => {
    const response = await window.invoker.planningChatList();
    return response.sessions.find((session) => session.terminalSessionId === terminalSessionId)?.id ?? null;
  }, sessionId);

  await installOutputRecorder(page, sessionId!);
  await page.screenshot({ path: screenshotBefore, fullPage: true, timeout: 60_000 });

  await writeTerminalCommand(page, sessionId!, "printf 'TMUX_SIZE before '; stty size");
  await waitForSttySample(page, sessionId!, 'before');

  const preZeroPayloadCount = (await recordedResizePayloads(page, electronApp)).filter((payload) => payload.sessionId === sessionId).length;
  await forceZeroSizeTmuxHost(page);

  if (mode === 'before') {
    await page.waitForTimeout(750);
  } else {
    await page.waitForTimeout(750);
  }

  await writeTerminalCommand(page, sessionId!, "printf 'TMUX_SIZE after '; stty size");
  await waitForSttySample(page, sessionId!, 'after');
  await page.screenshot({ path: screenshotAfter, fullPage: true, timeout: 60_000 });

  const payloads = (await recordedResizePayloads(page, electronApp)).filter((payload) => payload.sessionId === sessionId);
  const terminal = await terminalEvidence(page, sessionId!);
  const sttySizeSamples = parseSttySizeSamples(terminal.output);
  const tinyResizePayloads = payloads.filter(isTinyGeometry);
  const postZeroTinyResizePayloads = payloads.slice(preZeroPayloadCount).filter(isTinyGeometry);
  const tinySttySizeSamples = sttySizeSamples.filter(isTinyGeometry);
  const artifact = {
    mode,
    planningSessionId,
    sessionId,
    recorderInstall: await page.evaluate(() => {
      const targetWindow = window as unknown as { __planningTmuxBlankRecorderInstall?: Record<string, unknown> };
      return targetWindow.__planningTmuxBlankRecorderInstall ?? null;
    }),
    mainIpcRecorderInstall: await electronApp.evaluate(() => {
      const targetGlobal = globalThis as unknown as { __planningTmuxBlankMainResizeRecorderInstall?: Record<string, unknown> };
      return targetGlobal.__planningTmuxBlankMainResizeRecorderInstall ?? null;
    }),
    resizePayloads: payloads,
    outputSnapshotTail: terminal.outputSnapshot.slice(-4000),
    sttySizeSamples,
    screenshotPaths: {
      before: screenshotBefore,
      after: screenshotAfter,
    },
  };
  await fs.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`, 'utf8');
  await testInfo.attach('planning-tmux-blank-repro', {
    path: artifactPath,
    contentType: 'application/json',
  });

  expect(sttySizeSamples.some((sample) => sample.label === 'before')).toBe(true);
  expect(sttySizeSamples.some((sample) => sample.label === 'after')).toBe(true);

  if (mode === 'before') {
    expect(tinyResizePayloads.length, 'expected at least one tiny planningTerminalResize payload').toBeGreaterThan(0);
    expect(postZeroTinyResizePayloads.length, 'expected a tiny planningTerminalResize payload after the zero-size transition').toBeGreaterThan(0);
    expect(tinySttySizeSamples.length, 'expected at least one tiny PTY stty size sample').toBeGreaterThan(0);
    console.log(`BUG_REPRODUCED=${JSON.stringify({
      artifactPath,
      sessionId,
      tinyResizePayloads: tinyResizePayloads.length,
      tinySttySizeSamples,
    })}`);
  } else {
    expect(tinyResizePayloads, 'no tiny planningTerminalResize payload should be sent after the fix').toEqual([]);
    expect(tinySttySizeSamples, 'no tiny PTY stty size sample should be observed after the fix').toEqual([]);
    console.log(`FIX_VERIFIED=${JSON.stringify({
      artifactPath,
      sessionId,
      resizePayloads: payloads.length,
      sttySizeSamples,
    })}`);
  }
});
