/**
 * Reproduces the SAME unmount-on-conditional-render bug as
 * planning-terminal-chat-tmux-toggle-garble-repro.spec.ts, but triggered by
 * navigating away from the Planning surface (Home) to the Workflow graph
 * surface and back, instead of the internal Chat/Tmux toggle.
 *
 * Root cause: packages/ui/src/App.tsx has a top-level ternary keyed on
 * `sidebarSurface` (~line 4998) that renders EITHER
 * renderPlanningTerminalSurface() (contains InvokerTerminal/PlanningTmuxPane)
 * OR the Workflow graph OR other surfaces -- never more than one at a time.
 * That's a plain conditional render, not a persistent-mount + CSS-toggle, so
 * switching sidebarSurface fully unmounts/remounts InvokerTerminal, which
 * destroys the live xterm.js terminal exactly like the Chat/Tmux bug did
 * before it was fixed. The Chat/Tmux fix only protects a component that
 * stays mounted -- it can't help once the component's own parent stops
 * rendering it.
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

test.describe('Planning surface navigation garble repro', () => {
  test('tmux pane keeps the same rendered content across a Planning -> Workflow graph -> Planning round trip', async ({ page }, testInfo) => {
    let sessionId = '';
    try {
      await openHome(page);
      sessionId = await openPlanningTmux(page);

      await writeToTmux(page, sessionId, DRAW_FULL_SCREEN_FRAME);
      await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: 10000 }).toContain(FRAME_MARKER);
      await page.waitForTimeout(300);

      const renderedBefore = await readTmuxBufferText(page);
      expect(renderedBefore, 'expected the test hook to expose the live xterm.js Terminal').not.toBeNull();
      const beforeScreenshot = testInfo.outputPath('surface-nav-before.png');
      await page.screenshot({ path: beforeScreenshot });
      await testInfo.attach('before-nav', { path: beforeScreenshot, contentType: 'image/png' });
      await testInfo.attach('rendered-buffer-before', { body: renderedBefore ?? '', contentType: 'text/plain' });

      // Navigate away to the Workflow graph surface and back to Planning --
      // no interaction with the terminal at all, just top-level nav. The
      // Home surface now stays mounted (fixed), just CSS-hidden -- it no
      // longer disappears from the DOM.
      await page.getByTestId('sidebar-planning').click();
      await expect(page.getByTestId('invoker-terminal-input')).not.toBeVisible();
      await page.waitForTimeout(300);

      // `mode` ('chat' vs 'tmux') is shared App-level state, not internal to
      // InvokerTerminal, so it survives the remount and the pane comes back
      // already in Tmux mode -- don't assume the chat input reappears.
      await page.getByTestId('sidebar-home').click();
      await expect(page.getByTestId('sidebar-home')).toHaveAttribute('aria-current', 'page', { timeout: 10000 });
      const paneAfterNav = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(paneAfterNav).toBeVisible({ timeout: 10000 });
      const sessionIdAfterNav = await paneAfterNav.getAttribute('data-session-id');
      await page.waitForTimeout(300);

      const renderedAfter = await readTmuxBufferText(page);
      const afterScreenshot = testInfo.outputPath('surface-nav-after.png');
      await page.screenshot({ path: afterScreenshot });
      await testInfo.attach('after-nav', { path: afterScreenshot, contentType: 'image/png' });
      await testInfo.attach('rendered-buffer-after', { body: renderedAfter ?? '', contentType: 'text/plain' });

      expect(sessionIdAfterNav, 'the tmux pane must keep attaching to the same backend session after nav').toBe(sessionId);
      expect(renderedAfter, 'the rendered terminal content must be identical before and after navigating Planning -> Workflow graph -> Planning').toBe(renderedBefore);
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
