import {
  captureScreenshot,
  expect,
  loadPlan,
  test,
  TEST_PLAN,
  waitForInvokerBridge,
} from './fixtures/electron-app.js';

test('critical memory pressure preserves state, then repeated renderer loss stops on a diagnostic', async ({ electronApp, page }) => {
  await loadPlan(page, TEST_PLAN);
  const selectedTask = page.locator('.react-flow__node[data-testid$="task-beta"]').first();
  await selectedTask.click();
  await expect(selectedTask.locator('[data-selected="true"]')).toBeVisible();
  await expect(page.getByTestId('workflow-inspector-shell')).toContainText('Second test task depending on alpha');
  await captureScreenshot(page, 'renderer-recovery-selected-before');

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

  const replacementPagePromise = electronApp.waitForEvent('window');
  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('no BrowserWindow found');
    window.webContents.forcefullyCrashRenderer();
  });
  const recoveredPage = await replacementPagePromise;

  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getOSProcessId();
  })).not.toBe(rendererPidBeforePressure);
  await waitForInvokerBridge(recoveredPage);
  const restoredTask = recoveredPage.locator('.react-flow__node[data-testid$="task-beta"]').first();
  await expect(restoredTask.locator('[data-selected="true"]')).toBeVisible();
  await expect(recoveredPage.getByTestId('workflow-inspector-shell')).toContainText('Second test task depending on alpha');
  await captureScreenshot(recoveredPage, 'renderer-recovery-selected-after');

  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) throw new Error('no BrowserWindow found');
    window.webContents.forcefullyCrashRenderer();
  });

  await expect.poll(async () => electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    return window?.webContents.getURL();
  })).toContain('data:text/html');

  const recoveryPage = electronApp.windows()[0];
  if (!recoveryPage) throw new Error('recovery page was not created');
  await recoveryPage.waitForLoadState('domcontentloaded');
  await expect(recoveryPage.getByRole('heading', { name: 'Invoker' })).toBeVisible();
  await expect(recoveryPage.getByText('The UI failed to load.')).toBeVisible();
  await expect.poll(async () => recoveryPage.evaluate(() => document.body.innerText.trim())).not.toBe('');
  await captureScreenshot(recoveryPage, 'renderer-recovery-crash-loop-diagnostic');
});
