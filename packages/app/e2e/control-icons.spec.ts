/**
 * E2E: ReactFlow Controls icon visibility.
 *
 * Regression test for the white-on-white icon bug where the dark app theme
 * caused ReactFlow control button SVGs to be invisible.
 * See commit 74f32ec.
 */

import { test, expect } from './fixtures/electron-app.js';

test.describe('ReactFlow Controls icon visibility', () => {
  test('control button icons should be black (#000)', async ({ page }) => {
    const color = await page.evaluate(() => {
      const btn = document.createElement('button');
      btn.className = 'react-flow__controls-button';
      document.body.appendChild(btn);
      const style = getComputedStyle(btn);
      const color = style.getPropertyValue('--xy-controls-button-color').trim();
      document.body.removeChild(btn);
      return color;
    });

    expect(color).toBe('#000');
  });
});
