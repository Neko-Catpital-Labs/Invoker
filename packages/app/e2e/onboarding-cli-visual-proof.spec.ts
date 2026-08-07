/**
 * E2E: CLI onboarding visual proof.
 *
 * Drives the app's embedded terminal (the Planning "Tmux" pane, backed by
 * node-pty -- see InvokerTerminal.tsx / TerminalDrawer.tsx) to run the real
 * `invoker-cli setup` wizard (packages/cli/src/onboarding.ts) and captures a
 * named screenshot at each onboarding scenario. Remote-machine connectivity
 * is forced deterministically via INVOKER_TEST_REMOTE_TARGET_STUB (see
 * packages/contracts/src/remote-target-onboarding.ts); Slack credential
 * validation is forced deterministically via a `--require` fetch stub (see
 * fixtures/slack-fetch-stub-preload.cjs) so nothing here needs a real remote
 * host, real Slack app, or network access.
 *
 * Only runs when CAPTURE_MODE is set (see fixtures/electron-app.ts
 * captureScreenshot) -- driven by scripts/ui-visual-proof.sh capture-after.
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveRepoRoot, REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR } from '@invoker/contracts';
import type { Page } from '@playwright/test';
import { test, expect, captureScreenshot } from './fixtures/electron-app.js';
import {
  SLACK_FETCH_STUB_ENV_VAR,
  SLACK_FETCH_STUB_PRELOAD_PATH,
  slackFetchStubBadTokenJson,
  slackFetchStubSuccessJson,
} from './fixtures/slack-fetch-stub.js';

const repoRoot = resolveRepoRoot(__dirname);
const cliEntry = path.join(repoRoot, 'packages', 'cli', 'dist', 'index.js');

test.beforeAll(() => {
  if (!fs.existsSync(cliEntry)) {
    execFileSync('pnpm', ['--filter', '@invoker/cli', 'run', 'build'], { cwd: repoRoot, stdio: 'inherit' });
  }
});

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
  await expect
    .poll(async () => readOutputSnapshot(page, sessionId ?? ''), { timeout: 10000 })
    .toContain('Invoker planning tmux bridge');
  return sessionId ?? '';
}

async function writeToTmux(page: Page, sessionId: string, data: string): Promise<void> {
  const result = await page.evaluate(async ({ targetSessionId, payload }) => {
    return window.invoker.planningTerminalWrite(targetSessionId, payload);
  }, { targetSessionId: sessionId, payload: data });
  expect(result).toMatchObject({ ok: true });
}

async function waitForTerminalText(page: Page, sessionId: string, substring: string, timeoutMs = 30000): Promise<void> {
  await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: timeoutMs }).toContain(substring);
}

async function waitForTerminalMatch(page: Page, sessionId: string, pattern: RegExp, timeoutMs = 30000): Promise<void> {
  await expect.poll(async () => readOutputSnapshot(page, sessionId), { timeout: timeoutMs }).toMatch(pattern);
}

interface MachineAnswers {
  name: string;
  host: string;
  user: string;
  sshKeyPath: string;
}

/** The 7 sequential prompts of askRemoteTargetInput(); port/max/provision left blank (defaults). */
function machineAnswers(input: MachineAnswers): string {
  return `${[input.name, input.host, input.user, input.sshKeyPath, '', '', ''].join('\n')}\n`;
}

test.describe('CLI onboarding visual proof', () => {
  test('captures every named onboarding-cli scenario', async ({ page }) => {
    test.setTimeout(240_000);

    await openHome(page);
    const sessionId = await openPlanningTmux(page);

    // ── Machines: happy path (empty -> checking -> success -> loop -> final state) ──
    const happyPathStub = JSON.stringify({
      'alpha.e2e.test': { reachable: true, message: 'ssh probe to deploy@alpha.e2e.test succeeded' },
      'beta.e2e.test': { reachable: true, message: 'ssh probe to deploy@beta.e2e.test succeeded' },
    });
    await writeToTmux(
      page,
      sessionId,
      `${REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR}='${happyPathStub}' node ${cliEntry} setup machines\n`,
    );
    await waitForTerminalText(page, sessionId, 'Machine name:');
    await captureScreenshot(page, 'cli-machine-empty');

    await writeToTmux(page, sessionId, machineAnswers({
      name: 'alpha-machine',
      host: 'alpha.e2e.test',
      user: 'deploy',
      sshKeyPath: '/home/deploy/.ssh/id_alpha',
    }));
    await page.waitForTimeout(150);
    await captureScreenshot(page, 'cli-machine-checking');

    await waitForTerminalText(page, sessionId, 'Connectivity check passed: ssh probe to deploy@alpha.e2e.test succeeded');
    await captureScreenshot(page, 'cli-machine-success');

    // Keep alpha-machine, add another, then fill in beta-machine and keep it too.
    await writeToTmux(
      page,
      sessionId,
      `y\ny\n${machineAnswers({
        name: 'beta-machine',
        host: 'beta.e2e.test',
        user: 'deploy',
        sshKeyPath: '/home/deploy/.ssh/id_beta',
      })}y\n`,
    );
    await waitForTerminalText(page, sessionId, 'Wrote machine "beta-machine"');
    await captureScreenshot(page, 'cli-machine-loop-second-added');

    await writeToTmux(page, sessionId, 'n\n');
    await waitForTerminalMatch(page, sessionId, /You're ready\.|Fix this first:/);
    await captureScreenshot(page, 'cli-machine-final-state');

    // ── Machines: connectivity failure ──
    const failureStub = JSON.stringify({
      'down.e2e.test': { reachable: false, message: 'ssh: connect to host down.e2e.test port 22: Connection refused' },
    });
    await writeToTmux(
      page,
      sessionId,
      `${REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR}='${failureStub}' node ${cliEntry} setup machines\n${machineAnswers({
        name: 'down-machine',
        host: 'down.e2e.test',
        user: 'deploy',
        sshKeyPath: '/home/deploy/.ssh/id_down',
      })}`,
    );
    await waitForTerminalText(page, sessionId, 'Connectivity check failed: ssh: connect to host down.e2e.test port 22: Connection refused');
    await captureScreenshot(page, 'cli-machine-failure');
    await writeToTmux(page, sessionId, 'n\nn\n');

    // ── Machines: duplicate host ──
    const duplicateHostStub = JSON.stringify({
      'dup.e2e.test': { reachable: true, message: 'ssh probe to deploy@dup.e2e.test succeeded' },
    });
    await writeToTmux(
      page,
      sessionId,
      `${REMOTE_TARGET_CONNECTIVITY_STUB_ENV_VAR}='${duplicateHostStub}' node ${cliEntry} setup machines\n`
      + machineAnswers({ name: 'dup-a', host: 'dup.e2e.test', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_dup_a' })
      + 'y\ny\n'
      + machineAnswers({ name: 'dup-b', host: 'dup.e2e.test', user: 'deploy', sshKeyPath: '/home/deploy/.ssh/id_dup_b' })
      + 'y\n',
    );
    await waitForTerminalText(page, sessionId, 'Nothing written: host "dup.e2e.test" is already configured as remote target "dup-a"');
    await captureScreenshot(page, 'cli-machine-duplicate-host');
    await writeToTmux(page, sessionId, 'n\n');

    // ── Slack: decline, then review + finish (bare `setup`, no subcommand) ──
    await writeToTmux(page, sessionId, `node ${cliEntry} setup\nn\nn\nn\n`);
    await waitForTerminalText(page, sessionId, 'Set up remote machines now?');
    await captureScreenshot(page, 'cli-slack-decline');
    await waitForTerminalText(page, sessionId, 'smoke: plan validation');
    await captureScreenshot(page, 'cli-review');
    await waitForTerminalMatch(page, sessionId, /You're ready\.|Fix this first:/);
    await captureScreenshot(page, 'cli-finish');

    // ── Slack: bad token (offline fetch stub) ──
    await writeToTmux(
      page,
      sessionId,
      `NODE_OPTIONS="--require ${SLACK_FETCH_STUB_PRELOAD_PATH}" ${SLACK_FETCH_STUB_ENV_VAR}='${slackFetchStubBadTokenJson()}' `
      + `node ${cliEntry} setup slack\nxoxb-bad-token\nxapp-bad-token\nbad-signing-secret\nC0BADTOKEN\n`,
    );
    await waitForTerminalText(page, sessionId, 'auth.test failed: invalid_auth');
    await captureScreenshot(page, 'cli-slack-bad-token');
    await writeToTmux(page, sessionId, 'n\n');

    // ── Slack: success (offline fetch stub) ──
    await writeToTmux(
      page,
      sessionId,
      `NODE_OPTIONS="--require ${SLACK_FETCH_STUB_PRELOAD_PATH}" ${SLACK_FETCH_STUB_ENV_VAR}='${slackFetchStubSuccessJson()}' `
      + `node ${cliEntry} setup slack\nxoxb-success-token\nxapp-success-token\nsuccess-signing-secret\nC0SUCCESS\n`,
    );
    await waitForTerminalText(page, sessionId, 'Authenticated as invoker-bot in Invoker E2E');
    await captureScreenshot(page, 'cli-slack-success');
  });
});
