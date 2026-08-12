import { expect, test, waitForInvokerBridge } from './fixtures/electron-app.js';

test('critical memory pressure keeps the UI responsive and renderer loss shows a diagnostic', async ({ electronApp }) => {
  test.fail(true, 'renderer-loss fallback is truncated by its unescaped data URL');
  const page = await electronApp.firstWindow();
  await waitForInvokerBridge(page);

  const rendererPidBeforePressure = await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('no BrowserWindow found');
    return window.webContents.getOSProcessId();
  });

  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Memory.simulatePressureNotification', { level: 'critical' });

  await expect.poll(async () => page.evaluate(() => typeof window.invoker)).toBe('object');
  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getOSProcessId();
  })).toBe(rendererPidBeforePressure);

  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('no BrowserWindow found');
    window.webContents.forcefullyCrashRenderer();
  });

  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getURL();
  })).toContain('data:text/html');
  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getOSProcessId();
  })).not.toBe(rendererPidBeforePressure);

  const recoveryPage = electronApp.windows()[0];
  if (!recoveryPage) throw new Error('recovery page was not created');
  await recoveryPage.waitForLoadState('domcontentloaded');
  await expect(recoveryPage.getByRole('heading', { name: 'Invoker' })).toBeVisible();
  await expect(recoveryPage.getByText('The UI failed to load.')).toBeVisible();
  await expect.poll(async () => recoveryPage.evaluate(() => document.body.innerText.trim())).not.toBe('');
});
