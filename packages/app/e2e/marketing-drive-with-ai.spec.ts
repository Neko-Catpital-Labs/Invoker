/**
 * Marketing capture: smaller Claude Code terminal floating over Invoker Plan graph.
 * Typing “submit to invoker” then materializes the workflow on the DAG behind Claude.
 */
import { expect, type Frame, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  test,
  E2E_REPO_URL,
  loadPlan,
} from './fixtures/electron-app.js';

const OUTPUT_DIR = process.env.MARKETING_OUTPUT_DIR
  ?? path.resolve(__dirname, 'marketing-demos');
const FRAME_DIR = process.env.MARKETING_FRAME_DIR
  ?? path.resolve(__dirname, 'marketing-frames');
const VIEWPORT = { width: 1440, height: 900 };
const MOCK_PATH = path.resolve(__dirname, 'fixtures/claude-desktop-mock.html');
const OVERLAY_ID = 'marketing-claude-overlay';

const DRIVE_PLAN = {
  name: 'Checkout handlers',
  repoUrl: E2E_REPO_URL,
  onFinish: 'none' as const,
  tasks: [
    {
      id: 'implement-handlers',
      description: 'Implement checkout handlers',
      prompt: 'Implement the checkout request handlers with scrubbed fixture data.',
      dependencies: [],
    },
    {
      id: 'wire-tests',
      description: 'Wire handler tests',
      prompt: 'Add focused tests for the checkout handlers.',
      dependencies: ['implement-handlers'],
    },
    {
      id: 'review-gate',
      description: 'Open review gate',
      prompt: 'Prepare the PR review gate for checkout handlers.',
      dependencies: ['wire-tests'],
    },
  ],
};

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

async function fitGraph(page: Page): Promise<void> {
  const fit = page.getByRole('button', { name: 'Fit View' }).first();
  if (await fit.isVisible({ timeout: 2000 }).catch(() => false)) {
    await fit.click();
    await page.waitForTimeout(250);
  }
}

async function goHomeGraph(page: Page): Promise<void> {
  const home = page.getByTestId('sidebar-home');
  if (await home.isVisible({ timeout: 2000 }).catch(() => false)) {
    await home.click();
  } else {
    const workflows = page.getByTestId('sidebar-workflows');
    if (await workflows.isVisible({ timeout: 2000 }).catch(() => false)) {
      await workflows.click();
    }
  }
  await expect(page.getByRole('heading', { name: 'Plan graph' })).toBeVisible({ timeout: 10000 });
}

async function mountClaudeOverlay(page: Page, srcdoc: string): Promise<Frame> {
  await page.evaluate(({ id, html }) => {
    document.getElementById(id)?.remove();
    const host = document.createElement('div');
    host.id = id;
    host.setAttribute('data-marketing-claude-overlay', 'true');
    host.style.cssText = [
      'position:fixed',
      'right:56px',
      'bottom:72px',
      'width:720px',
      'height:460px',
      'z-index:2147483646',
      'border-radius:12px',
      'overflow:hidden',
      'box-shadow:0 28px 90px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.10)',
      'pointer-events:auto',
    ].join(';');
    const iframe = document.createElement('iframe');
    iframe.id = `${id}-frame`;
    iframe.title = 'Claude terminal';
    iframe.style.cssText = 'width:100%;height:100%;border:0;background:#0c0c0c;';
    iframe.srcdoc = html;
    host.appendChild(iframe);
    document.body.appendChild(host);
  }, { id: OVERLAY_ID, html: srcdoc });

  const iframeEl = page.locator(`#${OVERLAY_ID}-frame`);
  await expect(iframeEl).toBeVisible({ timeout: 5000 });
  const handle = await iframeEl.elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error('Claude overlay iframe has no content frame');
  await expect(frame.locator('[data-claude-mock]')).toBeVisible({ timeout: 5000 });
  return frame;
}

test('drive-with-ai claude terminal over invoker graph', async ({ page }) => {
  const scene = 'drive-with-ai';
  const framesDir = path.join(FRAME_DIR, scene);
  await fs.rm(framesDir, { recursive: true, force: true });
  await ensureDir(framesDir);
  await ensureDir(OUTPUT_DIR);

  let frame = 0;
  const capturePage = async () => {
    const name = `frame-${String(frame).padStart(3, '0')}.png`;
    frame += 1;
    await page.setViewportSize(VIEWPORT).catch(() => undefined);
    await page.screenshot({ path: path.join(framesDir, name), timeout: 60000 });
  };
  const hold = async (ms: number, everyMs = 100) => {
    const steps = Math.max(1, Math.round(ms / everyMs));
    for (let i = 0; i < steps; i += 1) {
      await page.waitForTimeout(everyMs);
      await capturePage();
    }
  };

  // Invoker Plan graph visible as the full background.
  await goHomeGraph(page);
  await page.evaluate(async () => {
    await window.invoker.deleteAllWorkflows();
  });
  await page.getByRole('button', { name: 'Refresh' }).click().catch(() => undefined);
  await page.waitForTimeout(300);
  await fitGraph(page);
  await capturePage();
  await hold(400);

  const mockHtml = await fs.readFile(MOCK_PATH, 'utf8');
  const claude = await mountClaudeOverlay(page, mockHtml);
  await hold(600);

  const message = 'submit to invoker';
  for (let i = 0; i < message.length; i += 1) {
    await claude.evaluate((partial) => {
      const typed = document.getElementById('typed');
      if (!typed) return;
      typed.textContent = partial;
    }, message.slice(0, i + 1));
    await hold(90, 90);
  }
  await hold(350);

  await claude.evaluate((text) => {
    const api = (window as unknown as {
      __claudeMock: { commitUserMessage: (t: string) => Promise<void> | void };
    }).__claudeMock;
    return api.commitUserMessage(text);
  }, message);
  await hold(400);

  // Materialize the workflow on the DAG while Claude stays floating in front.
  await loadPlan(page, DRIVE_PLAN);
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 });
  await fitGraph(page);
  await hold(500);

  await claude.evaluate(() => {
    (window as unknown as { __claudeMock: { showAssistantReply: () => void } })
      .__claudeMock.showAssistantReply();
  });
  await hold(1600);

  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${scene}.png`),
    timeout: 60000,
  });

  expect(frame).toBeGreaterThan(40);
});
