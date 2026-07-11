/**
 * Marketing capture: Claude Code terminal → "submit to invoker" → Invoker Plan graph.
 *
 * Frames land in MARKETING_FRAME_DIR/drive-with-ai for ffmpeg assembly.
 * Poster PNG lands in MARKETING_OUTPUT_DIR/drive-with-ai.png.
 */
import { expect, chromium, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
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

test('drive-with-ai claude submit to invoker graph', async ({ page }) => {
  const scene = 'drive-with-ai';
  const framesDir = path.join(FRAME_DIR, scene);
  await fs.rm(framesDir, { recursive: true, force: true });
  await ensureDir(framesDir);
  await ensureDir(OUTPUT_DIR);

  let frame = 0;
  const capturePage = async (target: Page) => {
    const name = `frame-${String(frame).padStart(3, '0')}.png`;
    frame += 1;
    await target.setViewportSize(VIEWPORT).catch(() => undefined);
    await target.screenshot({ path: path.join(framesDir, name), timeout: 60000 });
  };
  const hold = async (target: Page, ms: number, everyMs = 100) => {
    const steps = Math.max(1, Math.round(ms / everyMs));
    for (let i = 0; i < steps; i += 1) {
      await target.waitForTimeout(everyMs);
      await capturePage(target);
    }
  };

  // --- Part 1: Claude Code terminal session (Chromium mock) ---
  const browser = await chromium.launch({
    headless: process.env.INVOKER_E2E_HIDE_WINDOW !== '0',
  });
  try {
    const claude = await browser.newPage({ viewport: VIEWPORT });
    await claude.goto(pathToFileURL(MOCK_PATH).href);
    await expect(claude.locator('[data-claude-mock]')).toBeVisible();
    await capturePage(claude);
    await hold(claude, 500);

    const message = 'submit to invoker';
    for (let i = 0; i < message.length; i += 1) {
      await claude.evaluate((partial) => {
        const typed = document.getElementById('typed');
        if (!typed) return;
        typed.textContent = partial;
      }, message.slice(0, i + 1));
      await hold(claude, 90, 90);
    }
    await hold(claude, 350);
    await claude.evaluate((text) => {
      const api = (window as unknown as {
        __claudeMock: { commitUserMessage: (t: string) => Promise<void> | void };
      }).__claudeMock;
      return api.commitUserMessage(text);
    }, message);
    await hold(claude, 600);
    await claude.evaluate(() => {
      (window as unknown as { __claudeMock: { showAssistantReply: () => void } })
        .__claudeMock.showAssistantReply();
    });
    await hold(claude, 1200);
  } finally {
    await browser.close();
  }

  // --- Part 2: real Invoker Electron Plan graph ---
  await goHomeGraph(page);
  await page.evaluate(async () => {
    await window.invoker.deleteAllWorkflows();
  });
  await page.getByRole('button', { name: 'Refresh' }).click().catch(() => undefined);
  await hold(page, 400);
  await fitGraph(page);
  await hold(page, 500);

  await loadPlan(page, DRIVE_PLAN);
  await expect(page.locator('.react-flow__node').first()).toBeVisible({ timeout: 15000 });
  await fitGraph(page);
  await hold(page, 1600);

  await page.setViewportSize(VIEWPORT).catch(() => undefined);
  await page.screenshot({
    path: path.join(OUTPUT_DIR, `${scene}.png`),
    timeout: 60000,
  });

  expect(frame).toBeGreaterThan(40);
});
