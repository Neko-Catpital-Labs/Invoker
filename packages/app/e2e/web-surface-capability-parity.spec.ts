import {
  expect,
  test,
  WEB_SURFACE_TASK_ID,
  WEB_SURFACE_WORKFLOW_ID,
} from './fixtures/web-surface.js';

type InvokeRequest = {
  channel: string;
  method: string;
  url: string;
};

test('browser web surface proves Codex-only shared capability parity over authenticated HTTP', async ({
  page,
  webSurface,
}) => {
  const invokeRequests: InvokeRequest[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname !== '/invoke') return;
    const body = request.postDataJSON() as { channel?: unknown } | null;
    invokeRequests.push({
      channel: typeof body?.channel === 'string' ? body.channel : '<missing>',
      method: request.method(),
      url: request.url(),
    });
  });

  await page.goto(`${webSurface.baseUrl}/?token=${encodeURIComponent(webSurface.token)}`);
  await expect(page).toHaveURL(`${webSurface.baseUrl}/`);
  expect(await page.evaluate(() => {
    const browserWindow = window as typeof window & { invoker?: unknown; process?: unknown };
    return {
      protocol: browserWindow.location.protocol,
      hasInvoker: typeof browserWindow.invoker === 'object',
      hasNodeProcess: typeof browserWindow.process !== 'undefined',
    };
  })).toEqual({
    protocol: 'http:',
    hasInvoker: true,
    hasNodeProcess: false,
  });

  await expect.poll(
    () => invokeRequests.some((request) => request.channel === 'invoker:get-execution-harnesses'),
  ).toBe(true);
  await page.getByTestId('sidebar-planning').click();
  await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();
  const workflowNode = page.getByTestId(`workflow-node-${WEB_SURFACE_WORKFLOW_ID}`);
  await expect(workflowNode).toBeVisible();
  await workflowNode.click();

  const taskNode = page.locator(`.react-flow__node[data-testid="rf__node-${WEB_SURFACE_TASK_ID}"]`);
  await expect(taskNode).toBeVisible();
  await expect(taskNode.getByText('Failed', { exact: true })).toBeVisible();
  await taskNode.click({ button: 'right' });

  const menu = page.getByTestId('task-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Fix with Codex' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Fix with Claude' })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Fix with Codex' }).click();

  await expect.poll(() => webSurface.repairCalls).toEqual([
    { taskId: WEB_SURFACE_TASK_ID, agentName: 'codex' },
  ]);
  await expect.poll(
    () => invokeRequests.filter((request) => request.channel === 'invoker:fix-with-agent').length,
  ).toBe(1);
  await expect(taskNode.getByText('Approve fix', { exact: true })).toBeVisible();
  await taskNode.click();
  await expect(page.getByRole('button', { name: 'Approve Fix' })).toBeVisible();
  await webSurface.captureScreenshot(page);

  const claudeDenial = await page.evaluate(async (taskId) => {
    const response = await fetch('/invoke', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        channel: 'invoker:fix-with-agent',
        args: [taskId, 'claude'],
      }),
    });
    return {
      status: response.status,
      body: await response.json(),
    };
  }, WEB_SURFACE_TASK_ID);
  expect(claudeDenial).toEqual({
    status: 200,
    body: {
      ok: false,
      error: {
        message: 'request failed',
        code: 'execution_agent_disabled',
      },
    },
  });
  expect(webSurface.repairCalls).toEqual([
    { taskId: WEB_SURFACE_TASK_ID, agentName: 'codex' },
  ]);

  const lifecycleResult = await page.evaluate(async () => {
    const browserWindow = window as typeof window & {
      invoker: { startReady(request: { dryRun: boolean }): Promise<unknown> };
    };
    return browserWindow.invoker.startReady({ dryRun: true });
  });
  expect(lifecycleResult).toEqual({
    ok: true,
    source: 'shared-owner-registry',
    dryRun: true,
  });
  expect(webSurface.lifecycleCalls).toEqual([
    { channel: 'invoker:start-ready', request: { dryRun: true } },
  ]);

  expect(invokeRequests.filter((request) => request.channel === 'invoker:fix-with-agent')).toHaveLength(2);
  expect(invokeRequests.some((request) => request.channel === 'invoker:start-ready')).toBe(true);
  expect(invokeRequests.every((request) => request.method === 'POST')).toBe(true);
  expect(invokeRequests.every((request) => new URL(request.url).origin === webSurface.baseUrl)).toBe(true);
});
