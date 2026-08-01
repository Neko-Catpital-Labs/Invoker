/**
 * Same repro as planning-terminal-chat-tmux-toggle-garble-repro.spec.ts, but
 * driving the REAL `claude` CLI in the tmux pane instead of a synthetic
 * full-screen frame -- this is what the user actually typed and observed.
 *
 * Not part of the deterministic regression suite: a live CLI's screen can
 * legitimately differ run to run (spinners, token/cost counters, auth
 * state), so this is a manual verification script, run on demand.
 *
 * The e2e fixture normally shadows `claude` on PATH with a no-op stub
 * (electron-app.ts symlinks scripts/e2e-dry-run/fixtures/claude-marker.sh
 * as `claude` in a prepended stub dir) so other tests don't hit the real
 * network. This spec resolves and invokes the REAL binary by absolute path
 * to bypass that shadow on purpose.
 */

import { execFileSync } from 'node:child_process';
import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-app.js';

function resolveRealClaudeBinary(): string {
  const resolved = execFileSync('bash', ['-lc', 'command -v claude'], { encoding: 'utf8' }).trim();
  if (!resolved) {
    throw new Error('Could not resolve a real `claude` binary on PATH outside the e2e sandbox');
  }
  return resolved;
}

async function openHome(page: Page): Promise<void> {
  await page.getByTestId('sidebar-home').click();
  await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
}

async function readOutputSnapshot(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
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

async function switchMode(page: Page, mode: 'Chat' | 'Tmux'): Promise<void> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: mode }).click();
}

async function writeToTmux(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, payload }) => {
    return window.invoker.planningTerminalWrite(targetSessionId, payload);
  }, { targetSessionId: sessionId, payload: data });
  expect(result).toMatchObject({ ok: true });
}

async function readTmuxBufferText(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const term = window.__INVOKER_TEST_ACTIVE_PLANNING_TMUX_TERMINAL__;
    if (!term) return null;
    const lines: string[] = [];
    for (let row = 0; row < term.rows; row += 1) {
      lines.push(term.buffer.active.getLine(row)?.translateToString(true) ?? '');
    }
    return lines.join('\n');
  });
}

async function terminalDomNodeMarkerSurvived(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    const xtermEl = pane?.querySelector('.xterm');
    return xtermEl?.getAttribute('data-repro-marker') === 'still-here';
  });
}

async function tagTerminalDomNode(page: Page): Promise<void> {
  const tagged = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    const xtermEl = pane?.querySelector('.xterm');
    if (!xtermEl) return false;
    xtermEl.setAttribute('data-repro-marker', 'still-here');
    return true;
  });
  expect(tagged, 'expected a live .xterm DOM node inside the tmux pane to tag').toBe(true);
}

/** Waits until the session's output log stops growing for `quietMs`, so we
 * don't snapshot the screen mid-startup-animation. */
async function waitForOutputToStabilize(
  page: Page,
  sessionId: string,
  { quietMs = 1200, timeoutMs = 20000, pollMs = 250 } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = await readOutputSnapshot(page, sessionId);
  let lastChangeAt = Date.now();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    const snapshot = await readOutputSnapshot(page, sessionId);
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot;
      lastChangeAt = Date.now();
      continue;
    }
    if (Date.now() - lastChangeAt >= quietMs) return lastSnapshot;
  }
  return lastSnapshot;
}

function firstDiffLine(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const max = Math.max(beforeLines.length, afterLines.length);
  for (let i = 0; i < max; i += 1) {
    if (beforeLines[i] !== afterLines[i]) {
      return `line ${i}:\n  before: ${JSON.stringify(beforeLines[i] ?? '<missing>')}\n  after:  ${JSON.stringify(afterLines[i] ?? '<missing>')}`;
    }
  }
  return '(no differing line found, but strings are unequal -- length mismatch?)';
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  }).catch(() => undefined);
}

test.describe('Planning terminal Chat/Tmux toggle garble repro (real claude session)', () => {
  test('tmux pane renders the real claude CLI identically before and after a Chat -> Tmux round trip', async ({ page }, testInfo) => {
    test.setTimeout(90000);
    const claudeBinary = resolveRealClaudeBinary();
    let sessionId = '';
    try {
      await openHome(page);
      sessionId = await openPlanningTmux(page);

      await writeToTmux(page, sessionId, `${claudeBinary}\n`);
      // Real startup renders progressively (banner, then onboarding UI);
      // don't gate on a brittle text match against raw escape-code output --
      // wait for it to stop changing instead.
      const stableOutput = await waitForOutputToStabilize(page, sessionId, { quietMs: 1500, timeoutMs: 45000 });
      expect(stableOutput, 'expected the real claude CLI to have produced output').toContain('Claude');
      await testInfo.attach('claude-startup-output', { body: stableOutput, contentType: 'text/plain' });

      await tagTerminalDomNode(page);

      const beforeScreenshot = testInfo.outputPath('real-claude-toggle-before.png');
      await page.screenshot({ path: beforeScreenshot });
      await testInfo.attach('before-toggle', { path: beforeScreenshot, contentType: 'image/png' });
      const renderedBefore = await readTmuxBufferText(page);
      expect(renderedBefore, 'expected the test hook to expose the live xterm.js Terminal').not.toBeNull();
      await testInfo.attach('rendered-buffer-before', { body: renderedBefore ?? '', contentType: 'text/plain' });

      await switchMode(page, 'Chat');
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await switchMode(page, 'Tmux');
      const paneAfterToggle = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(paneAfterToggle).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);

      const afterScreenshot = testInfo.outputPath('real-claude-toggle-after.png');
      await page.screenshot({ path: afterScreenshot });
      await testInfo.attach('after-toggle', { path: afterScreenshot, contentType: 'image/png' });
      const renderedAfter = await readTmuxBufferText(page);
      await testInfo.attach('rendered-buffer-after', { body: renderedAfter ?? '', contentType: 'text/plain' });

      expect(
        await terminalDomNodeMarkerSurvived(page),
        'the xterm terminal DOM node must be the SAME instance after switching Chat -> Tmux, not destroyed and recreated',
      ).toBe(true);

      if (renderedAfter !== renderedBefore) {
        console.log('REAL_CLAUDE_REPRO_DIFF:\n' + firstDiffLine(renderedBefore ?? '', renderedAfter ?? ''));
      }
      expect(renderedAfter, 'the rendered claude CLI content must be identical before and after the Chat -> Tmux round trip').toBe(renderedBefore);
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
