import { test, expect } from './fixtures/electron-app';

test.use({ guiOwnerMode: 'auto' });

test('auto GUI mode boots a daemon owner', async ({ page }) => {
  const runtimeStatus = await page.evaluate(async () => window.invoker.getRuntimeStatus());

  expect(runtimeStatus).toEqual({
    ownerMode: false,
    readOnly: false,
    mode: 'daemon-owner',
  });
});
