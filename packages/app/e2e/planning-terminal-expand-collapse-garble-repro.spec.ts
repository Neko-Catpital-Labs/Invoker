/**
 * Reproduces a THIRD instance of the same underlying bug class, via a
 * different mechanism than the other two repros in this directory.
 *
 * App.tsx renders TWO separate <InvokerTerminal> elements at two different
 * JSX positions: an inline one (~App.tsx:4748) and a fixed-overlay one
 * (~App.tsx:5083, only mounted while `planningTerminalExpanded` is true).
 * The inline instance's `terminalActive` prop is `!planningTerminalExpanded`
 * (App.tsx:4764) -- so expanding/collapsing the planning chat does not
 * merely show/hide an overlay, it also flips the INLINE instance's
 * `terminalActive` prop. PlanningTmuxPane's mount effect
 * (InvokerTerminal.tsx) is keyed on `terminalActive` in its dependency
 * array, so flipping it disposes the xterm.js Terminal and, when flipped
 * back, creates a brand-new one reseeded from the raw output log -- the
 * same garbling mechanism as the other two repros, triggered by the
 * Expand/Close buttons instead of a mode toggle or surface navigation.
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

/** Expanding to a fixed full-screen overlay legitimately gives xterm.js more
 * rows to fill (a real resize, not corruption) -- trailing blank lines
 * differ for that reason alone. Strip them so the comparison only catches
 * actual content differences. */
function trimTrailingBlankLines(text: string): string {
  return text.replace(/(\n[ \t]*)+$/, '');
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
  test('tmux pane keeps the same rendered content across an Expand -> Close round trip', async ({ page }, testInfo) => {
    let sessionId = '';
    try {
      await openHome(page);
      sessionId = await openPlanningTmux(page);

      await writeToTmux(page, sessionId, DRAW_FULL_SCREEN_FRAME);
      await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: 10000 }).toContain(FRAME_MARKER);
      await page.waitForTimeout(300);

      const renderedBeforeExpand = await readTmuxBufferText(page);
      expect(renderedBeforeExpand, 'expected the test hook to expose the live xterm.js Terminal').not.toBeNull();
      await testInfo.attach('rendered-buffer-before-expand', { body: renderedBeforeExpand ?? '', contentType: 'text/plain' });

      await page.getByRole('button', { name: 'Expand planning chat' }).click();
      const overlay = page.getByTestId('invoker-terminal-expanded');
      await expect(overlay).toBeVisible({ timeout: 10000 });
      await expect(overlay.getByTestId('invoker-terminal-tmux-pane')).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(500);

      const renderedWhileExpanded = await readTmuxBufferText(page);
      await testInfo.attach('rendered-buffer-while-expanded', { body: renderedWhileExpanded ?? '', contentType: 'text/plain' });
      const expandedScreenshot = testInfo.outputPath('expand-collapse-expanded.png');
      await page.screenshot({ path: expandedScreenshot });
      await testInfo.attach('while-expanded', { path: expandedScreenshot, contentType: 'image/png' });

      await overlay.getByRole('button', { name: 'Close planning chat' }).click();
      await expect(overlay).toHaveCount(0);
      await page.waitForTimeout(500);

      const renderedAfterClose = await readTmuxBufferText(page);
      const afterScreenshot = testInfo.outputPath('expand-collapse-after-close.png');
      await page.screenshot({ path: afterScreenshot });
      await testInfo.attach('after-close', { path: afterScreenshot, contentType: 'image/png' });
      await testInfo.attach('rendered-buffer-after-close', { body: renderedAfterClose ?? '', contentType: 'text/plain' });

      // Expanding genuinely resizes the pane (more rows in a fullscreen
      // overlay), so compare ignoring trailing blank padding from that
      // resize -- the actual content must still be untouched.
      expect(
        trimTrailingBlankLines(renderedWhileExpanded ?? ''),
        'the rendered terminal content must be unchanged (aside from added blank rows from the legitimate resize) when first expanding the planning chat',
      ).toBe(trimTrailingBlankLines(renderedBeforeExpand ?? ''));
      // Closing returns to the exact same viewport size as before expanding,
      // so this must be a byte-for-byte match, not just a trimmed one.
      expect(renderedAfterClose, 'the rendered terminal content must be identical after an Expand -> Close round trip').toBe(renderedBeforeExpand);
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
