import { test, expect } from './fixtures/electron-app';

test.use({ guiOwnerMode: 'auto' });

const WRITE_MARKER = 'DAEMON_OWNER_WRITE_OK';

async function readTerminalOutputSnapshot(page: import('@playwright/test').Page, sessionId: string): Promise<string> {
  return page.evaluate(async (targetSessionId) => {
    const sessions = await window.invoker.planningTerminalList();
    return sessions.find((session) => session.sessionId === targetSessionId)?.outputSnapshot ?? '';
  }, sessionId);
}

// Fixed by the next stack slice: today the local viewer never learns about a
// planning chat created on the daemon owner, so opening its tmux tab reports
// "not found"; even once opened, writes are rejected as read-only.
test.fail();
test('planning tmux tab opens and stays writable for a session created while running as a daemon-owner delegate', async ({ page }) => {
  const runtimeStatus = await page.evaluate(async () => window.invoker.getRuntimeStatus());
  expect(runtimeStatus.mode).toBe('daemon-owner');

  const created = await page.evaluate(async () => window.invoker.planningChatCreate());
  expect(created.ok).toBe(true);
  const sessionId = created.ok ? created.session.id : undefined;
  expect(sessionId).toBeTruthy();

  const result = await page.evaluate(async (sid) => window.invoker.planningTerminalOpen(sid), sessionId);
  expect(result.opened, `reason: ${(result as { reason?: string }).reason}`).toBe(true);
  const terminalSessionId = result.opened ? result.session.sessionId : undefined;
  expect(terminalSessionId).toBeTruthy();

  const writeResult = await page.evaluate(async ({ tsid, marker }) => {
    return window.invoker.planningTerminalWrite(tsid, `printf '${marker}'\n`);
  }, { tsid: terminalSessionId, marker: WRITE_MARKER });
  expect(writeResult, `writeResult: ${JSON.stringify(writeResult)}`).toMatchObject({ ok: true });

  await expect
    .poll(async () => readTerminalOutputSnapshot(page, terminalSessionId ?? ''), { timeout: 10000 })
    .toContain(WRITE_MARKER);
});
