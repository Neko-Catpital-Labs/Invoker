import { stringify as yamlStringify } from 'yaml';
import { test, expect, E2E_REPO_URL, waitForStableUI, captureScreenshot } from './fixtures/electron-app.js';

const SUBMIT_PLAN = {
  name: 'E2E Submit Flow Workflow',
  repoUrl: E2E_REPO_URL,
  baseBranch: 'master',
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'verify-submit',
      description: 'Verify the planning submit flow works',
      command: 'echo submit-verified',
      dependencies: [] as string[],
    },
    {
      id: 'downstream-task',
      description: 'Downstream dependent task',
      command: 'echo downstream',
      dependencies: ['verify-submit'],
    },
  ],
};

test('planning submit creates workflow and shows DAG on graph', async ({ page }) => {
  const planYaml = yamlStringify(SUBMIT_PLAN);
  const planReply = `I drafted the plan.\n\n\`\`\`yaml\n${planYaml}\`\`\``;

  await page.evaluate(async ({ yaml, name, reply }) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml: yaml,
      planName: name,
      reply,
    });
  }, { yaml: planYaml, name: SUBMIT_PLAN.name, reply: planReply });

  await page.getByTestId('sidebar-home').click();
  await page.getByRole('button', { name: 'Options' }).click();
  await expect(page.getByRole('heading', { name: 'Planning chat' })).toBeVisible();

  await page.getByTestId('invoker-terminal-input').fill('Draft a two-task plan');
  await page.getByRole('button', { name: 'Send' }).click();

  await expect(page.getByRole('heading', { name: 'Review draft' })).toBeVisible({ timeout: 10000 });
  await expect(page.getByTestId('draft-raw-yaml')).toContainText(SUBMIT_PLAN.name);

  await page.getByTestId('planning-create-workflow').click();

  const transcript = page.getByTestId('invoker-terminal-transcript');
  await expect(transcript).toContainText(`Plan "${SUBMIT_PLAN.name}" submitted to Invoker.`, { timeout: 15000 });

  await page.getByTestId('sidebar-planning').click();
  await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible();

  const workflowNode = page.locator('[data-testid^="workflow-node-"]').first();
  await expect(workflowNode).toBeVisible({ timeout: 10000 });

  await workflowNode.click();

  const miniDag = page.getByTestId('selected-workflow-mini-dag');
  await expect(miniDag).toBeVisible({ timeout: 10000 });
  await expect(miniDag).toContainText('E2E Submit Flow Workflow task DAG');

  const verifyNode = miniDag.locator('.react-flow__node[data-testid$="verify-submit"]');
  const downstreamNode = miniDag.locator('.react-flow__node[data-testid$="downstream-task"]');
  await expect(verifyNode).toBeVisible({ timeout: 10000 });
  await expect(downstreamNode).toBeVisible({ timeout: 10000 });

  await waitForStableUI(page);
  await captureScreenshot(page, 'planning-submit-workflow-graph');

  const workflows = await page.evaluate(() => window.invoker.listWorkflows());
  expect(workflows.length).toBeGreaterThan(0);
  const submittedWorkflow = workflows.find((wf: { name: string }) => wf.name === SUBMIT_PLAN.name);
  expect(submittedWorkflow).toBeDefined();
  expect(submittedWorkflow.status).toBe('pending');

  await page.evaluate(async () => {
    await window.invoker.setTestPlanningChatResponse(null);
  });
});
