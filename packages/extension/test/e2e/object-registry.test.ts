import { test, expect } from '@playwright/test';
import type { Page, BrowserContext, Locator } from '@playwright/test';

import { loadExtension } from '../helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('Object Registry', () => {
  let extensionContext: BrowserContext;
  let popupPage: Page;

  /**
   * Send a message to an object.
   *
   * @param page - The page to send the message on.
   * @param target - The target of the object.
   * @param method - The method to call.
   * @param params - The parameters to pass to the method.
   * @returns The message response locator.
   */
  const sendMessage = async (
    page: Page,
    target: string,
    method: string,
    params: string,
  ) => {
    await page
      .locator('select[data-testid="message-target"]')
      .selectOption(target);
    await page.locator('input[data-testid="message-method"]').fill(method);
    await page.locator('input[data-testid="message-params"]').fill(params);
    await page.locator('button[data-testid="message-send-button"]').click();
    return page.locator('[data-testid="message-response"]');
  };

  /**
   * Revoke an object.
   *
   * @param page - The page to revoke the object on.
   * @param owner - The owner of the object.
   * @param target - The target of the object.
   * @returns The button and output locator.
   */
  const revokeObject = async (
    page: Page,
    owner: string,
    target: string,
  ): Promise<{ button: Locator; output: Locator }> => {
    await page
      .locator(`[data-testid="accordion-header"]:has(:text("${owner}"))`)
      .click();
    const button = page.locator(`[data-testid="revoke-button-${target}"]`);
    await button.click();
    return { button, output: page.locator('[data-testid="message-output"]') };
  };

  test.beforeEach(async () => {
    const extension = await loadExtension();
    extensionContext = extension.browserContext;
    popupPage = extension.popupPage;
    await popupPage.click('button:text("Object Registry")');
    await expect(popupPage.locator('text=Kernel Registry')).toBeVisible();
  });

  test.afterEach(async () => {
    await extensionContext.close();
  });

  test('should send a message to an object', async () => {
    const clearLogsButton = popupPage.locator(
      '[data-testid="clear-logs-button"]',
    );
    await clearLogsButton.click();
    await popupPage.click('button:text("Object Registry")');
    await expect(
      popupPage.locator('text=Alice (v1) - 5 objects, 4 promises'),
    ).toBeVisible();
    const targetSelect = popupPage.locator('[data-testid="message-target"]');
    await expect(targetSelect).toBeVisible();
    const options = targetSelect.locator('option:not([value=""])');
    await expect(options).toHaveCount(await options.count());
    expect(await options.count()).toBeGreaterThan(0);
    await targetSelect.selectOption({ index: 1 });
    await expect(targetSelect).not.toHaveValue('');
    const methodInput = popupPage.locator('[data-testid="message-method"]');
    await expect(methodInput).toHaveValue('__getMethodNames__');
    const paramsInput = popupPage.locator('[data-testid="message-params"]');
    await expect(paramsInput).toHaveValue('[]');
    await popupPage.click('[data-testid="message-send-button"]');
    const messageResponse = popupPage.locator(
      '[data-testid="message-response"]',
    );
    await expect(messageResponse).toBeVisible();
    await expect(messageResponse).toContainText(
      '"body":"#[\\"__getInterfaceGuard__\\",\\"__getMethodNames__\\",\\"bootstrap\\",\\"doRunRun\\",\\"hello\\"]"',
    );
    await expect(messageResponse).toContainText('"slots":[]');
    await clearLogsButton.click();
    await methodInput.fill('hello');
    await paramsInput.fill('[]');
    await popupPage.click('[data-testid="message-send-button"]');
    await expect(messageResponse).toContainText('"body":"#\\"vat Alice got');
    await expect(messageResponse).toContainText('"slots":[');
    await expect(
      popupPage.locator('text=Alice (v1) - 5 objects, 6 promises'),
    ).toBeVisible();
  });

  test('should revoke an object', async () => {
    const owner = 'v1';
    const v1Root = 'ko4';
    const [target, method, params] = [v1Root, 'hello', '["Bob"]'];

    // Before revoking, we should be able to send a message to the object
    let response = await sendMessage(popupPage, target, method, params);
    await expect(response).toContainText(/body(.+):(.+)hello(.+)from(.+)Bob/u);

    const { button, output } = await revokeObject(popupPage, owner, target);
    await expect(output).toContainText(`Revoked object ${target}`);

    // After revoking, the revoke button should be disabled and show "Revoked"
    await expect(button).toBeDisabled();
    await expect(button).toHaveText('Revoked');

    // After revoking, the previously successful message should fail
    response = await sendMessage(popupPage, target, method, params);
    await expect(response).toContainText('has been revoked');
  });
});
