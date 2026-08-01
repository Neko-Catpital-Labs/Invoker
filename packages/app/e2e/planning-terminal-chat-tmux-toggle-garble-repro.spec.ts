/**
 * Reproduces the exact manual repro: open a new planning chat, switch to
 * Tmux, run a full-screen program, switch to Chat, switch back to Tmux, and
 * confirm the tmux pane looks the same before and after.
 *
 * Root cause (see plans/nested-wobbling-seahorse.md and
 * packages/ui/src/__tests__/invoker-terminal.test.tsx's
 * "keeps the same xterm Terminal instance across a chat/tmux mode toggle"):
 * the Chat/Tmux toggle in InvokerTerminal.tsx used to fully unmount
 * PlanningTmuxPane, destroying its xterm.js Terminal, then rebuild a brand
 * new one on switch-back and replay the raw output log into it. That fix
 * was reverted in this worktree to investigate a separate resize/PTY-size
 * bug first, so this spec is currently expected to FAIL again.
 *
 * A synthetic full-screen frame (absolute cursor-positioned ANSI writes) is
 * used in place of a real `claude` session so the repro is deterministic
 * and doesn't require live auth/network calls — it exercises the identical
 * failure class: full-screen, cursor-addressed redraws are exactly what a
 * real full-screen TUI like the Claude Code CLI produces.
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

async function switchMode(page: Page, mode: 'Chat' | 'Tmux'): Promise<void> {
  await page.getByTestId('invoker-terminal-mode-toggle').getByRole('tab', { name: mode }).click();
}

async function writeToTmux(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, payload }) => {
    return window.invoker.planningTerminalWrite(targetSessionId, payload);
  }, { targetSessionId: sessionId, payload: data });
  expect(result).toMatchObject({ ok: true });
}

/** Tags the live terminal's root DOM node so we can tell, after a mode
 * toggle, whether it's still the SAME node (fixed) or a freshly created one
 * (bug: the pane was destroyed and rebuilt). */
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

async function terminalDomNodeMarkerSurvived(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const pane = document.querySelector('[data-testid="invoker-terminal-tmux-pane"]');
    const xtermEl = pane?.querySelector('.xterm');
    return xtermEl?.getAttribute('data-repro-marker') === 'still-here';
  });
}

/**
 * Synthesizes the tmux pane's currently RENDERED state as a single string,
 * reading every row straight from xterm.js's own buffer (not the DOM, which
 * xterm.js paints to a <canvas> with no accessible text; not the backend's
 * raw output log, which doesn't change on a UI-only toggle and so can't
 * detect a bad replay). This is what the user actually sees on screen.
 */
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
// Clears the screen, then writes text at absolute cursor positions -- the
// same class of escape sequences a real full-screen TUI (the Claude Code
// CLI included) uses to draw its UI.
const DRAW_FULL_SCREEN_FRAME =
  "printf '\\033[2J\\033[H'" +
  "; printf '\\033[3;5HTOP LEFT FRAME'" +
  "; printf '\\033[10;20HBOTTOM RIGHT FRAME'" +
  `; printf '\\033[24;1H${FRAME_MARKER}'` +
  '\n';

test.describe('Planning terminal Chat/Tmux toggle garble repro', () => {
  test('tmux pane keeps the same terminal instance and content across a Chat -> Tmux round trip', async ({ page }, testInfo) => {
    let sessionId = '';
    try {
      await openHome(page);
      sessionId = await openPlanningTmux(page);

      await writeToTmux(page, sessionId, DRAW_FULL_SCREEN_FRAME);
      await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: 10000 }).toContain(FRAME_MARKER);
      await page.waitForTimeout(300);

      await tagTerminalDomNode(page);

      const beforeScreenshot = testInfo.outputPath('chat-tmux-toggle-before.png');
      await page.screenshot({ path: beforeScreenshot });
      await testInfo.attach('before-toggle', { path: beforeScreenshot, contentType: 'image/png' });
      const outputSnapshotBefore = await readOutputSnapshot(page, sessionId);
      const renderedBefore = await readTmuxBufferText(page);
      expect(renderedBefore, 'expected the test hook to expose the live xterm.js Terminal').not.toBeNull();
      await testInfo.attach('rendered-buffer-before', { body: renderedBefore ?? '', contentType: 'text/plain' });

      await switchMode(page, 'Chat');
      await expect(page.getByTestId('invoker-terminal-input')).toBeVisible({ timeout: 10000 });
      await switchMode(page, 'Tmux');
      const paneAfterToggle = page.getByTestId('invoker-terminal-tmux-pane');
      await expect(paneAfterToggle).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(300);

      const sessionIdAfterToggle = await paneAfterToggle.getAttribute('data-session-id');
      const afterScreenshot = testInfo.outputPath('chat-tmux-toggle-after.png');
      await page.screenshot({ path: afterScreenshot });
      await testInfo.attach('after-toggle', { path: afterScreenshot, contentType: 'image/png' });
      const outputSnapshotAfter = await readOutputSnapshot(page, sessionId);
      const renderedAfter = await readTmuxBufferText(page);
      await testInfo.attach('rendered-buffer-after', { body: renderedAfter ?? '', contentType: 'text/plain' });

      // Same backend session throughout -- this is not testing whether a
      // new PTY got spawned, only whether the UI's terminal survived.
      expect(sessionIdAfterToggle, 'the tmux pane must keep attaching to the same backend session').toBe(sessionId);
      expect(outputSnapshotAfter, "the main process's output log must be untouched by a UI-only mode toggle").toBe(outputSnapshotBefore);

      // The actual bug: does the toggle destroy and rebuild the terminal?
      expect(
        await terminalDomNodeMarkerSurvived(page),
        'the xterm terminal DOM node must be the SAME instance after switching Chat -> Tmux, not destroyed and recreated (this is the reported garbling bug)',
      ).toBe(true);

      // The direct test: synthesize the tmux pane's rendered state as a
      // string before and after, and compare them exactly.
      expect(renderedAfter, 'the rendered terminal content must be byte-for-byte identical before and after the Chat -> Tmux round trip').toBe(renderedBefore);
    } finally {
      if (sessionId) {
        await closePlanningTerminalSessions(page);
      }
    }
  });
});
