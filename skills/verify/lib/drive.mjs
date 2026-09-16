import { mkdtempSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export async function launchIsolatedApp(opts) {
  const { _electron: electron } = await import('@playwright/test');
  const mainJs = join(opts.repoRoot, 'packages/app/dist/main.js');
  if (!existsSync(mainJs)) {
    throw new Error(`missing ${mainJs} — run pnpm --filter @invoker/app build`);
  }

  const testDir = mkdtempSync(join(tmpdir(), 'invoker-verify-drive-'));
  const electronUserDataDir = join(testDir, 'electron-user-data');
  const ipcSocketPath = join(testDir, 'invoker.sock');
  const configPath = join(testDir, 'config.json');
  writeFileSync(configPath, JSON.stringify({ worktreeBaseDir: join(testDir, 'worktrees') }, null, 2));

  const app = await electron.launch({
    args: [
      ...(process.platform === 'linux'
        ? ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu']
        : []),
      `--user-data-dir=${electronUserDataDir}`,
      mainJs,
    ],
    env: {
      ...process.env,
      NODE_ENV: 'test',
      INVOKER_TEST_WORKFLOW_IDS: '1',
      INVOKER_DISABLE_SLACK: '1',
      TZ: 'UTC',
      INVOKER_GUI_OWNER_MODE: 'gui',
      INVOKER_DB_DIR: testDir,
      INVOKER_IPC_SOCKET: ipcSocketPath,
      INVOKER_E2E_ENABLE_COMPOSITOR: '1',
      INVOKER_REPO_CONFIG_PATH: configPath,
      INVOKER_TEST_FIXED_NOW: '2025-01-01T00:00:00.000Z',
    },
  });

  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  await page.waitForFunction(() => typeof window.invoker !== 'undefined', null, { timeout: 30_000 });
  await delay(250);
  return { app, page, testDir };
}

export async function runDrive(opts) {
  const { action, args, dryRun, repoRoot } = opts;
  const supported = new Set(['snapshot', 'screenshot', 'click', 'aria-click', 'press', 'send']);
  if (!supported.has(action)) {
    return { ok: false, exitCode: 1, error: `unknown drive action: ${action}` };
  }
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      exitCode: 0,
      action,
      args,
      detail: `would launch isolated Electron and run ${action}`,
    };
  }

  let session;
  try {
    session = await launchIsolatedApp({ repoRoot });
    const { app, page } = session;
    let result = {};

    if (action === 'snapshot') {
      result = { snapshot: await page.accessibility.snapshot() };
    } else if (action === 'screenshot') {
      const out = resolve(args.out || join(tmpdir(), `invoker-verify-${Date.now()}.png`));
      await page.screenshot({ path: out, timeout: 60_000 });
      result = { path: out };
    } else if (action === 'click') {
      const testid = args.testid || args.target;
      if (!testid) throw new Error('click requires --testid <data-testid>');
      await page.getByTestId(testid).click({ timeout: 15_000 });
      result = { clicked: testid };
    } else if (action === 'aria-click') {
      const name = args.name || args.target;
      if (!name) throw new Error('aria-click requires --name <accessible name>');
      await page.getByRole(args.role || 'button', { name }).click({ timeout: 15_000 });
      result = { clicked: name, role: args.role || 'button' };
    } else if (action === 'press') {
      const key = args.key || args.target;
      if (!key) throw new Error('press requires --key <chord>');
      await page.keyboard.press(key);
      result = { pressed: key };
    } else if (action === 'send') {
      const text = args.text || args.target;
      if (!text) throw new Error('send requires --text <message>');
      const chat = page.getByTestId('planning-chat-input');
      if (await chat.count()) {
        await chat.fill(text);
        await page.keyboard.press('Enter');
      } else {
        await page.keyboard.type(text);
        await page.keyboard.press('Enter');
      }
      result = { sent: text };
    }

    await app.close();
    return { ok: true, dryRun: false, exitCode: 0, action, ...result };
  } catch (err) {
    try {
      await session?.app?.close();
    } catch {
      void 0;
    }
    return { ok: false, exitCode: 1, error: err instanceof Error ? err.message : String(err), action };
  }
}
