import { test, expect, waitForStableUI, E2E_REPO_URL } from './fixtures/electron-app.js';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { stringify as yamlStringify } from 'yaml';

function yamlPlan(plan: Record<string, unknown>): string {
  return yamlStringify(plan);
}

const OUT_DIR = path.resolve(__dirname, '..', 'e2e-scratch', 'attach-workflow');

test('attach removes the Detached badge from a workflow node', async ({ page }) => {
  await fs.mkdir(OUT_DIR, { recursive: true });

  const upstreamIdsBefore = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((w: { id: string }) => w.id);
  });
  await page.evaluate((p) => window.invoker.loadPlan(p), yamlPlan({
    name: 'e2e-attach-upstream',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none',
    tasks: [{ id: 'up', description: 'upstream', command: 'echo up' }],
  }));
  const upstreamId: string = await page.waitForFunction(
    (knownIds) => window.invoker.listWorkflows().then((workflows: { id: string }[]) => {
      const created = workflows.find((w) => !knownIds.includes(w.id));
      return created?.id ?? null;
    }),
    upstreamIdsBefore,
    { timeout: 10000 },
  ).then((handle) => handle.jsonValue());
  expect(upstreamId).toBeTruthy();

  const downstreamIdsBefore = await page.evaluate(async () => {
    const workflows = await window.invoker.listWorkflows();
    return workflows.map((w: { id: string }) => w.id);
  });
  await page.evaluate((p) => window.invoker.loadPlan(p), yamlPlan({
    name: 'e2e-attach-downstream',
    repoUrl: E2E_REPO_URL,
    onFinish: 'none',
    externalDependencies: [{ workflowId: upstreamId, gatePolicy: 'completed' }],
    tasks: [{ id: 'down', description: 'downstream', command: 'echo down' }],
  }));
  const downstreamId: string = await page.waitForFunction(
    (knownIds) => window.invoker.listWorkflows().then((workflows: { id: string }[]) => {
      const created = workflows.find((w) => !knownIds.includes(w.id));
      return created?.id ?? null;
    }),
    downstreamIdsBefore,
    { timeout: 10000 },
  ).then((handle) => handle.jsonValue());
  expect(downstreamId).toBeTruthy();

  await page.getByTestId('sidebar-planning').click();
  await page.getByRole('button', { name: 'Refresh' }).click();

  await page.evaluate((id) => window.invoker.detachWorkflow(id[0], id[1]), [downstreamId, upstreamId]);
  await page.waitForFunction(
    (id) => window.invoker.listWorkflows().then((workflows: any[]) =>
      (workflows.find((w) => w.id === id)?.detachedExternalDependencies?.length ?? 0) > 0),
    downstreamId,
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await waitForStableUI(page);

  const nodeLocator = page.getByTestId(`workflow-node-${downstreamId}`);
  await nodeLocator.waitFor({ state: 'visible', timeout: 10000 });
  const badgeBefore = page.getByTestId(`workflow-node-${downstreamId}-detached-lineage`);
  await expect(badgeBefore).toBeVisible();
  await nodeLocator.screenshot({ path: path.join(OUT_DIR, 'before-detached-badge.png') });

  page.once('dialog', (dialog) => void dialog.accept());
  await nodeLocator.dispatchEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, buttons: 2 });
  await page.getByRole('menuitem', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Attach to...' }).click();
  const picker = page.getByTestId('attach-workflow-picker');
  await expect(picker).toHaveAttribute('data-state', 'open');
  await picker.locator('input').fill(upstreamId);
  await picker.getByText('e2e-attach-upstream').click();

  await page.waitForFunction(
    (id) => window.invoker.listWorkflows().then((workflows: any[]) =>
      (workflows.find((w) => w.id === id)?.detachedExternalDependencies?.length ?? 0) === 0),
    downstreamId,
    { timeout: 10000 },
  );
  await page.getByRole('button', { name: 'Refresh' }).click();
  await waitForStableUI(page);

  const badgeAfter = page.getByTestId(`workflow-node-${downstreamId}-detached-lineage`);
  await expect(badgeAfter).toHaveCount(0);
  await nodeLocator.screenshot({ path: path.join(OUT_DIR, 'after-no-detached-badge.png') });
});
