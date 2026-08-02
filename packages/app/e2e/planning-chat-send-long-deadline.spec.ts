import { stringify as yamlStringify } from 'yaml';
import { test, expect, E2E_REPO_URL, waitForRuntimeMode } from './fixtures/electron-app';

test.use({ guiOwnerMode: 'auto', standaloneOwnerIdleTimeoutMs: '90000' });

const PLAN_YAML = yamlStringify({
  name: 'Long Deadline Proof Plan',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'capture-proof',
      description: 'Capture the long-deadline proof',
      command: 'echo long-deadline-proof',
      dependencies: [],
    },
  ],
});

test('planning-chat-send survives a planner reply slower than the old 30s transport deadline', async ({ page }) => {
  // This window is a delegate, not the owner: planningChatSend goes out over
  // the real IPC socket transport (headless.gui-mutation), the exact path
  // that used to hard-timeout at 30s regardless of how long the planner took.
  await waitForRuntimeMode(page, 'daemon-owner', 30_000);
  const runtimeStatus = await page.evaluate(async () => window.invoker.getRuntimeStatus());
  expect(runtimeStatus.mode).toBe('daemon-owner');

  const created = await page.evaluate(async () => window.invoker.planningChatCreate());
  expect(created.ok).toBe(true);
  const sessionId = created.ok ? created.session.id : undefined;
  expect(sessionId).toBeTruthy();

  await page.evaluate(async (planYaml) => {
    await window.invoker.setTestPlanningChatResponse({
      planYaml,
      planName: 'Long Deadline Proof Plan',
      reply: 'Investigated why PR #6459 was not queued by the admin-bypass land worker.',
      // Longer than the old hardcoded 30s transport deadline.
      delayMs: 32_000,
    });
  }, PLAN_YAML);

  const startedAt = Date.now();
  const result = await page.evaluate(async (sid) => {
    return window.invoker.planningChatSend({
      sessionId: sid,
      message: 'why was PR #6459 not queued by our PR Admin Bypass land worker?',
      presetKey: 'codex',
    });
  }, sessionId);
  const elapsedMs = Date.now() - startedAt;

  expect(result.ok).toBe(true);
  // Proves the send was not killed by the transport deadline: it only
  // resolved after actually waiting out the artificial 32s planner delay.
  expect(elapsedMs).toBeGreaterThanOrEqual(32_000);

  await page.evaluate(async () => {
    await window.invoker.setTestPlanningChatResponse(null);
  });
});
