import minimalClusterConfig from '@ocap/kernel-test/minimal-cluster' with { type: 'json' };
import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

import { loadExtension } from '../helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('Kernel Persistence', () => {
  let extensionContext: BrowserContext;
  let extensionId: string;
  let popupPage: Page;

  test.beforeEach(async () => {
    const extension = await loadExtension();
    extensionContext = extension.browserContext;
    extensionId = extension.extensionId;
    popupPage = extension.popupPage;
  });

  test.afterEach(async () => {
    await extensionContext.close();
  });

  test('should handle new subclusters after restart', async () => {
    const fileInput = popupPage.locator(
      '[data-testid="subcluster-config-input"]',
    );
    const fileContent = JSON.stringify(minimalClusterConfig);
    await fileInput.setInputFiles({
      name: 'config.json',
      mimeType: 'application/json',
      buffer: Buffer.from(fileContent),
    });
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Subcluster launched');
    await expect(popupPage.locator('text=Subcluster s2 - 1 Vat')).toBeVisible();
    await popupPage.close();
    const newPopupPage = await extensionContext.newPage();
    await newPopupPage.goto(`chrome-extension://${extensionId}/popup.html`);
    await expect(
      newPopupPage.locator('text=Subcluster s1 - 3 Vats'),
    ).toBeVisible();
    await expect(
      newPopupPage.locator('text=Subcluster s2 - 1 Vat'),
    ).toBeVisible();
    // reload the extension
    await newPopupPage.evaluate(() => chrome.runtime.reload());
    await newPopupPage.close();
    const reloadedPopupPage = await extensionContext.newPage();
    // Wait for the extension to fully reload
    await reloadedPopupPage.waitForTimeout(1000);
    await reloadedPopupPage.goto(
      `chrome-extension://${extensionId}/popup.html`,
    );
    await reloadedPopupPage.waitForTimeout(1000);
    await expect(
      reloadedPopupPage.locator('text=Subcluster s1 - 3 Vats'),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      reloadedPopupPage.locator('text=Subcluster s2 - 1 Vat'),
    ).toBeVisible();
    await reloadedPopupPage.close();
  });
});
