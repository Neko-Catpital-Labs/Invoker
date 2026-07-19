/**
 * E2E: Visual proof for workflow-graph viewport preservation across planning
 * window switches.
 *
 * Drives the exact transition under review: pan the home workflow graph, leave
 * to the planning surface, then return home. Each captured frame is numbered
 * and carries an on-screen cue for the step it represents.
 */

import {
  test,
  expect,
  TEST_PLAN,
  loadPlan,
  captureScreenshot,
} from './fixtures/electron-app.js';
import type { Locator, Page } from '@playwright/test';

async function viewportTransform(viewport: Locator): Promise<string> {
  return viewport.evaluate((element) => {
    const htmlElement = element as HTMLElement;
    return htmlElement.style.transform || getComputedStyle(htmlElement).transform || '';
  });
}

async function waitForStableViewportTransform(page: Page, viewport: Locator): Promise<string> {
  let previous = await viewportTransform(viewport);
  for (let i = 0; i < 15; i += 1) {
    await page.waitForTimeout(120);
    const current = await viewportTransform(viewport);
    if (current === previous) return current;
    previous = current;
  }
  return previous;
}

test.describe('Graph viewport across planning window switches', () => {
  test('graph-viewport-switch — panned workflow graph survives a planning round trip', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await loadPlan(page, TEST_PLAN);

    const graphSurface = page.getByTestId('workflow-graph-surface');
    await expect(graphSurface).toBeVisible({ timeout: 15000 });
    const viewport = graphSurface.locator('.react-flow__viewport').first();
    await expect(viewport).toBeVisible({ timeout: 15000 });

    const fitted = await waitForStableViewportTransform(page, viewport);
    await captureScreenshot(page, 'graph-viewport-switch-step-1-home-fitted');

    const pane = graphSurface.locator('.react-flow__pane').first();
    await pane.hover();
    await page.mouse.wheel(0, -360);
    await page.waitForTimeout(200);
    await page.mouse.wheel(0, 240);

    const panned = await waitForStableViewportTransform(page, viewport);
    expect(panned).not.toBe(fitted);
    await captureScreenshot(page, 'graph-viewport-switch-step-2-home-user-panned');

    await page.getByTestId('sidebar-planning').click();
    await expect(page.getByTestId('planning-session-rail')).toBeVisible({ timeout: 15000 });
    await captureScreenshot(page, 'graph-viewport-switch-step-3-planning-surface');

    await page.getByTestId('sidebar-home').click();
    await expect(graphSurface).toBeVisible({ timeout: 15000 });

    const restored = await waitForStableViewportTransform(page, viewport);
    await captureScreenshot(page, 'graph-viewport-switch-step-4-home-return-preserved');

    expect(restored).toBe(panned);
  });
});
