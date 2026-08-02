/**
 * Regression coverage for the planning terminal expand/collapse path.
 *
 * Expanding the planning chat legitimately changes xterm geometry and can
 * reflow a live shell prompt. The invariant that matters for the historical
 * garbling bug is that Expand/Close does not destroy and recreate the xterm.js
 * terminal. This spec writes a cursor-addressed full-screen frame, then proves
 * the same backend session and same xterm DOM node survive while the frame
 * anchors remain visible before, during, and after expanded mode.
 */

import type { Page } from '@playwright/test';
import { expect, test } from './fixtures/electron-app.js';

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

/** Tags the live terminal's root DOM node so expand/collapse can prove the
 * same xterm.js instance stayed mounted. */
async function tagTerminalDomNode(page: Page): Promise<void> {
  const tagged = await page.evaluate(() => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    const xtermEl = pane?.querySelector('.xterm');
    if (!xtermEl) return false;
    xtermEl.setAttribute('data-expand-collapse-repro-marker', 'still-here');
    return true;
  });
  expect(tagged, 'expected a live .xterm DOM node inside the tmux pane to tag').toBe(true);
}

async function terminalDomNodeMarkerSurvived(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    const xtermEl = pane?.querySelector('.xterm');
    return xtermEl?.getAttribute('data-expand-collapse-repro-marker') === 'still-here';
  });
}

function expectFrameAnchors(rendered: string | null, label: string): void {
  expect(rendered, `${label}: expected the test hook to expose the live xterm.js Terminal`).not.toBeNull();
  const lines = (rendered ?? '').split('\n');
  expect(lines[2] ?? '', `${label}: top-left frame anchor must remain visible`).toContain('TOP LEFT FRAME');
  expect(lines[9] ?? '', `${label}: bottom-right frame anchor must remain visible`).toContain('BOTTOM RIGHT FRAME');
}

async function closePlanningTerminalSessions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const sessions = await window.invoker.planningTerminalList();
    await Promise.all(sessions.map((session) => window.invoker.planningTerminalClose(session.sessionId)));
  }).catch(() => undefined);
}

const FRAME_MARKER = 'FULLSCREEN_FRAME_READY';
const DRAW_FULL_SCREEN_FRAME =
  "printf '\\033[2J\\033[H'" +
  "; printf '\\033[3;5HTOP LEFT FRAME'" +
  "; printf '\\033[10;20HBOTTOM RIGHT FRAME'" +
  `; printf '\\033[24;1H${FRAME_MARKER}'` +
  '\n';

test.describe('Planning terminal Expand/Close garble repro', () => {
  test('tmux pane preserves the same terminal instance and frame anchors across an Expand -> Close round trip', async ({ page }, testInfo) => {
    let sessionId = '';
    try {
      await openHome(page);
      sessionId = await openPlanningTmux(page);

      await writeToTmux(page, sessionId, DRAW_FULL_SCREEN_FRAME);
      await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: 10000 }).toContain(FRAME_MARKER);
      await page.waitForTimeout(300);

      const renderedBeforeExpand = await readTmuxBufferText(page);
      expectFrameAnchors(renderedBeforeExpand, 'before expand');
      await tagTerminalDomNode(page);
      await testInfo.attach('rendered-buffer-before-expand', { body: renderedBeforeExpand ?? '', contentType: 'text/plain' });

      await page.getByRole('button', { name: 'Expand planning chat' }).click();
      const overlay = page.getByTestId('invoker-terminal-expanded');
      await expect(overlay).toBeVisible({ timeout: 10000 });
      const paneWhileExpanded = overlay.getByTestId('invoker-terminal-tmux-pane');
      await expect(paneWhileExpanded).toBeVisible({ timeout: 10000 });
      await expect(paneWhileExpanded).toHaveAttribute('data-session-id', sessionId);
      await page.waitForTimeout(500);

      const renderedWhileExpanded = await readTmuxBufferText(page);
      await testInfo.attach('rendered-buffer-while-expanded', { body: renderedWhileExpanded ?? '', contentType: 'text/plain' });
      const expandedScreenshot = testInfo.outputPath('expand-collapse-expanded.png');
      await page.screenshot({ path: expandedScreenshot });
      await testInfo.attach('while-expanded', { path: expandedScreenshot, contentType: 'image/png' });
      expect(
        await terminalDomNodeMarkerSurvived(page),
        'the xterm terminal DOM node must be the SAME instance while expanded, not destroyed and recreated',
      ).toBe(true);
      expect(await readOutputSnapshot(page, sessionId), 'the backend session output must still contain the test frame marker after expanding').toContain(FRAME_MARKER);
      expectFrameAnchors(renderedWhileExpanded, 'while expanded');

      await overlay.getByRole('button', { name: 'Close planning chat' }).click();
      await expect(overlay).toHaveCount(0);
      const paneAfterClose = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(paneAfterClose).toBeVisible({ timeout: 10000 });
      await expect(paneAfterClose).toHaveAttribute('data-session-id', sessionId);
      await page.waitForTimeout(500);

      const renderedAfterClose = await readTmuxBufferText(page);
      const afterScreenshot = testInfo.outputPath('expand-collapse-after-close.png');
      await page.screenshot({ path: afterScreenshot });
      await testInfo.attach('after-close', { path: afterScreenshot, contentType: 'image/png' });
      await testInfo.attach('rendered-buffer-after-close', { body: renderedAfterClose ?? '', contentType: 'text/plain' });
      expect(
        await terminalDomNodeMarkerSurvived(page),
        'the xterm terminal DOM node must be the SAME instance after closing expanded mode, not destroyed and recreated',
      ).toBe(true);
      expect(await readOutputSnapshot(page, sessionId), 'the backend session output must still contain the test frame marker after closing expanded mode').toContain(FRAME_MARKER);
      expectFrameAnchors(renderedAfterClose, 'after close');
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
