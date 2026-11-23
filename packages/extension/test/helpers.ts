import { makeLoadExtension } from '@ocap/repo-tools/test-utils/extension';
import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export { sessionPath } from '@ocap/repo-tools/test-utils/extension';

const extensionPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist',
);

export const loadExtension = async (contextId?: string) => {
  const result = await makeLoadExtension({
    contextId,
    extensionPath,
    onPageLoad: async (popupPage) => {
      // Wait for the default subcluster accordion to be visible
      await expect(
        popupPage.locator('text=Subcluster s1 - 3 Vats'),
      ).toBeVisible();
    },
  });

  // Wrap browserContext.close to auto-attach logs
  const originalClose = result.browserContext.close.bind(result.browserContext);
  result.browserContext.close = async () => {
    await result.attachLogs();
    return originalClose();
  };

  return result;
};

/**
 * Find Alice's root object, the one message target named as hers. Looked up
 * rather than hardcoded: the subcluster's vats start in parallel, so their
 * roots are numbered in whatever order they finish starting.
 *
 * @param page - The page to look on, showing the Object Registry.
 * @returns Its kref.
 */
export const aliceRoot = async (page: Page): Promise<string> => {
  const kref = await page
    .locator('select[data-testid="message-target"] option', {
      hasText: '(Alice)',
    })
    .getAttribute('value');
  expect(kref).toBeTruthy();
  return kref as string;
};
