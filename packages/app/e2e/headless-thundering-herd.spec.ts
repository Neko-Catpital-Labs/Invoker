/**
 * Thundering-herd regression test.
 *
 * Original CI failure: when 8+ headless CLI invocations burst-submitted
 * workflows while a GUI owner was running, the routing logic only recognised
 * standalone owners as valid delegation targets. Every headless process fell
 * through to standalone-owner bootstrap, spawning 8+ competing Electron
 * processes that fought over the database lock and froze the UI.
 *
 * After the routing fix, all headless processes delegate to the live GUI owner.
 * This spec verifies:
 *   1. Burst submissions complete without spawning standalone owners.
 *   2. Burst retries via the IPC bridge do not freeze the renderer.
 *   3. No stray `owner-serve` Electron processes are left behind.
 */

import { execFile } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { promisify } from 'node:util';
import type { Page } from '@playwright/test';
import { stringify as yamlStringify } from 'yaml';

import {
  E2E_REPO_URL,
  TEST_PLAN,
  expect,
  loadPlan,
  startPlan,
  test,
} from './fixtures/electron-app.js';

// ---------------------------------------------------------------------------
// Helpers – scoped to this spec, not shared fixtures
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(__dirname, '..', '..', '..');

/** Run the headless CLI in a subprocess sharing the test's DB dir. */
async function runHeadlessClient(
  testDir: string,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const configPath = path.join(testDir, 'e2e-config.json');
  const ipcSocketPath = path.join(testDir, 'ipc-transport.sock');
  const clientPath = path.join(repoRoot, 'packages', 'app', 'dist', 'headless-client.js');
  return await execFileAsync('node', [clientPath, ...args], {
    cwd: repoRoot,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_REPO_CONFIG_PATH: configPath,
    },
    maxBuffer: 10 * 1024 * 1024,
  });
}

/** Extract the workflow ID printed by the headless CLI on stdout. */
function parseWorkflowId(stdout: string): string {
  const delegated = stdout.match(/Delegated to owner — workflow: (wf-[^\s]+)/);
  if (delegated?.[1]) return delegated[1];
  const direct = stdout.match(/Workflow ID: (wf-[^\s]+)/);
  if (direct?.[1]) return direct[1];
  throw new Error(`No workflow id found in stdout:\n${stdout}`);
}

/**
 * Click a task node and verify the command panel appears within `timeoutMs`.
 * Used to assert that the renderer event loop is not blocked.
 */
async function assertTaskPanelResponsive(page: Page, timeoutMs: number): Promise<void> {
  const taskNode = page.locator('.react-flow__node[data-testid$="task-alpha"]');
  const commandDisplay = page.locator('[data-testid="command-display"]');
  const startedAt = Date.now();
  await expect(async () => {
    await taskNode.click();
    await expect(commandDisplay).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: timeoutMs });
  const interactionMs = Date.now() - startedAt;
  expect(interactionMs).toBeLessThan(timeoutMs);
}

// ---------------------------------------------------------------------------
// Test
// ---------------------------------------------------------------------------

test.describe('Headless thundering herd', () => {
  test('burst headless restarts do not spawn headless electron herds or freeze the UI', async ({ page, testDir }) => {
    // -----------------------------------------------------------------------
    // Phase 1 – Establish a running GUI owner
    //
    // Load and start the standard test plan so the GUI process owns the DB.
    // The task-alpha node must be visible before we submit headless work,
    // because the herd bug only triggers when a GUI owner is already live.
    // -----------------------------------------------------------------------
    await loadPlan(page, TEST_PLAN);
    await startPlan(page);
    await page.locator('.react-flow__node[data-testid$="task-alpha"]').waitFor({ state: 'visible', timeout: 10000 });

    // Discover the active workflow through the owner's IPC bridge.
    // Using listWorkflows() (a read-only query) avoids opening the DB
    // directly, which would violate the single-writer owner boundary.
    const workflows = await page.evaluate(() => window.invoker.listWorkflows());
    expect(workflows.length).toBeGreaterThan(0);
    const currentWorkflowId = workflows[0].id as string;

    // -----------------------------------------------------------------------
    // Phase 2 – Burst-submit 8 headless workflows
    //
    // This is the core herd trigger: 8 rapid `run --no-track` invocations
    // while the GUI owner is live. Before the routing fix, each process
    // would fall through to standalone bootstrap. After the fix, each
    // delegates to the GUI owner and returns immediately.
    //
    // We parse workflow IDs from each process's stdout (not from the DB)
    // to avoid owner-boundary violations and ambiguity when many workflows
    // are created concurrently.
    // -----------------------------------------------------------------------
    const herdPlan = {
      name: 'Headless Herd Seed',
      repoUrl: E2E_REPO_URL,
      onFinish: 'none' as const,
      tasks: [
        {
          id: 'burst-root',
          description: 'Burst root',
          command: 'sleep 1 && echo burst-root',
          dependencies: [],
        },
      ],
    };
    const planPath = path.join(testDir, 'headless-herd-plan.yaml');
    await writeFile(planPath, yamlStringify(herdPlan), 'utf8');

    const workflowIds = new Set<string>();
    workflowIds.add(currentWorkflowId);
    for (let i = 0; i < 8; i += 1) {
      const result = await runHeadlessClient(testDir, ['run', planPath, '--no-track']);
      workflowIds.add(parseWorkflowId(result.stdout));
    }

    // -----------------------------------------------------------------------
    // Phase 3 – Burst-retry all workflows via IPC and probe UI responsiveness
    //
    // Retrying every workflow through the IPC bridge stress-tests the
    // renderer's ability to handle a mutation storm. The key contract:
    // the task panel must respond to clicks within the timeout, proving
    // the event loop is not starved.
    //
    // Two probes (before and after a settle delay) catch both immediate
    // freeze and delayed starvation from queued IPC responses.
    // -----------------------------------------------------------------------

    // Allow IPC messages from Phase 2 submissions to reach the owner.
    await page.waitForTimeout(500);

    const retryIds = Array.from(workflowIds);
    const burst = retryIds.map((workflowId) =>
      page.evaluate(async (id) => window.invoker.retryWorkflow(id), workflowId),
    );

    // Probe 1: UI must respond during the retry storm.
    await assertTaskPanelResponsive(page, 15000);

    // Settle: let queued IPC responses drain before the second probe.
    await page.waitForTimeout(1500);

    // Probe 2: UI must still respond after the storm settles.
    await assertTaskPanelResponsive(page, 15000);

    // Wait for all retry promises so Playwright doesn't tear down mid-flight.
    await Promise.allSettled(burst);

    // -----------------------------------------------------------------------
    // Phase 4 – Assert the herd contract
    //
    // These are the two invariants the routing fix must preserve:
    //   a) Renderer stayed responsive (event loop lag + long task budgets).
    //   b) No stray `owner-serve` Electron processes were spawned.
    // -----------------------------------------------------------------------

    // (a) Renderer performance budgets.
    //     maxRendererEventLoopLagMs < 1000: the main-thread event loop was
    //     never starved for a full second (would cause visible jank).
    //     maxRendererLongTaskMs < 1500: no single long task exceeded the
    //     budget (would block input and paint).
    const perf = await page.evaluate(async () => await window.invoker.getUiPerfStats());
    expect(perf.maxRendererEventLoopLagMs).toBeLessThan(1000);
    expect(perf.maxRendererLongTaskMs).toBeLessThan(1500);

    // (b) No stray owner-serve processes.
    //     Before the routing fix, each headless process that failed to
    //     delegate would spawn its own `electron ... --headless owner-serve`
    //     process. After the fix, zero such processes should exist.
    const ownerServe = await execFileAsync('bash', [
      '-lc',
      "pgrep -af '[e]lectron/dist/electron .*packages/app/dist/main.js.*--headless owner-serve' || true",
    ]);
    expect(ownerServe.stdout.trim()).toBe('');
  });
});
