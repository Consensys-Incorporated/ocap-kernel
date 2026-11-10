import { startRelay } from '@metamask/kernel-utils/libp2p';
import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';
import { rm } from 'node:fs/promises';

import { loadExtension, sessionPath } from '../helpers.ts';

test.describe.configure({ mode: 'serial', timeout: 90_000 });

/**
 * End-to-end tests for remote communications functionality.
 *
 * These tests simulate two independent kernels running in separate browser contexts
 * to test the remote communications features that enable kernels to communicate
 * over the network via libp2p.
 *
 * Key differences from regular kernel tests:
 * - Uses two separate browser extension instances with different user data directories
 * - Each kernel has its own peer identity and storage
 * - Tests actual network communication patterns
 */
test.describe('Remote Communications', () => {
  let extensionContext1: BrowserContext;
  let extensionContext2: BrowserContext;
  let popupPage1: Page;
  let popupPage2: Page;

  test.beforeAll(async () => {
    // Clean up any existing test data
    await rm(sessionPath, { recursive: true, force: true });
    // Start the relay
    await startRelay(console);
    await new Promise((resolve) => setTimeout(resolve, 2000));
  });

  test.beforeEach(async () => {
    // Create two independent extension instances with separate contexts to simulate separate kernels
    const extension1 = await loadExtension('kernel1');
    const extension2 = await loadExtension('kernel2');

    extensionContext1 = extension1.browserContext;
    extensionContext2 = extension2.browserContext;
    popupPage1 = extension1.popupPage;
    popupPage2 = extension2.popupPage;

    // Wait for both kernels to be fully loaded
    await expect(
      popupPage1.locator('text=Subcluster s1 - 3 Vats'),
    ).toBeVisible();
    await expect(
      popupPage2.locator('text=Subcluster s1 - 3 Vats'),
    ).toBeVisible();
  });

  test.afterEach(async () => {
    await extensionContext1.close();
    await extensionContext2.close();
  });

  /**
   * Helper function to get peer ID from Remote Comms tab.
   *
   * @param popupPage - The popup page for the kernel instance.
   * @returns The peer ID displayed in the UI.
   */
  async function getPeerIdFromUI(popupPage: Page): Promise<string> {
    await popupPage.click('button:text("Remote Comms")');
    await expect(
      popupPage.locator('[data-testid="peer-id-display"]'),
    ).toBeVisible();

    const peerIdElement = popupPage.locator('[data-testid="peer-id-display"]');
    const peerId = await peerIdElement.inputValue(); // Use inputValue for input elements

    if (!peerId) {
      throw new Error('Peer ID not found in UI');
    }

    return peerId.trim();
  }

  test('should connect two kernels and send remote message', async () => {
    // Get peer IDs from both kernels via Remote Comms tab
    const peerId1 = await getPeerIdFromUI(popupPage1);
    const peerId2 = await getPeerIdFromUI(popupPage2);

    // Verify kernels have different peer IDs (proving they're independent)
    expect(peerId1).toBeTruthy();
    expect(peerId2).toBeTruthy();
    expect(peerId1).not.toBe(peerId2);

    // Get an ocap URL from kernel2's Remote Comms tab
    await popupPage2.click('button:text("Remote Comms")');

    // Wait for the exported URLs to be scanned and displayed
    await expect(popupPage2.locator('text=Exported Object URLs')).toBeVisible({
      timeout: 10000,
    });

    // Get the first exported ocap URL (should be the bob vat from bootstrap)
    const firstOcapUrlInput = popupPage2
      .locator('[data-testid^="ocap-url-"]')
      .first();
    await expect(firstOcapUrlInput).toBeVisible();
    const ocapUrl = await firstOcapUrlInput.inputValue();

    expect(ocapUrl).toMatch(/^ocap:/u);
    expect(ocapUrl).toContain(peerId2); // Should contain kernel2's peer ID

    // focus on kernel1
    await popupPage1.bringToFront();

    // Go to Object Registry tab on kernel1 to send the remote message
    await popupPage1.click('button:text("Object Registry")');

    // Select the first target (alice vat)
    const targetSelect = popupPage1.locator('[data-testid="message-target"]');
    await expect(targetSelect).toBeVisible();
    const options = await targetSelect.locator('option').all();
    expect(options.length).toBeGreaterThan(1);
    await targetSelect.selectOption({ value: 'ko4' });
    expect(await targetSelect.inputValue()).toBe('ko4');

    // Set method to doRunRun (the remote communication method)
    const methodInput = popupPage1.locator('[data-testid="message-method"]');
    await methodInput.fill('doRunRun');

    // Set params to the ocap URL from kernel2
    const paramsInput = popupPage1.locator('[data-testid="message-params"]');
    await paramsInput.fill(`["${ocapUrl}"]`);

    await popupPage1.waitForTimeout(1000);

    const sendButton = popupPage1.locator(
      '[data-testid="message-send-button"]',
    );
    await expect(sendButton).toBeVisible();

    await sendButton.click();
    const messageResponse = popupPage1.locator(
      '[data-testid="message-response"]',
    );
    // Budget: redemption timeout is `ackTimeoutMs * (MAX_RETRIES + 1)` =
    // 40s with prod defaults; the response (success or rejection) is
    // guaranteed to render before then. 50s gives 10s headroom for the
    // post-redemption render path under CI load.
    await expect(messageResponse).toBeVisible({ timeout: 50_000 });
    await expect(messageResponse).toContainText(
      // oxlint-disable-next-line no-useless-escape
      `Response:{\"body\":\"#\\\"vat Bob got \\\\\\\"hello\\\\\\\" from remote Alice\\\"\",\"slots\":[]}`,
    );
  });
});
