import minimalClusterConfig from '@ocap/kernel-test/minimal-cluster' assert { type: 'json' };
import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

import { loadExtension } from '../helpers.ts';

test.describe.configure({ mode: 'serial' });

test.describe('Control Panel', () => {
  let extensionContext: BrowserContext;
  let popupPage: Page;

  test.beforeEach(async () => {
    const extension = await loadExtension();
    extensionContext = extension.browserContext;
    popupPage = extension.popupPage;
  });

  test.afterEach(async () => {
    await extensionContext.close();
  });

  /**
   * Launches a subcluster with the given configuration.
   *
   * @param config - The cluster configuration object to use for launching the subcluster.
   */
  async function launchSubcluster(config: object): Promise<void> {
    const fileInput = popupPage.locator(
      '[data-testid="subcluster-config-input"]',
    );
    const fileContent = JSON.stringify(config);
    await fileInput.setInputFiles({
      name: 'config.json',
      mimeType: 'application/json',
      buffer: Buffer.from(fileContent),
    });
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Subcluster launched');
  }

  /**
   * Read the Database Inspector's kv dump.
   *
   * @returns Every key/value pair it is showing.
   */
  async function readKvDump(): Promise<{ key: string; value: string }[]> {
    const text =
      (await popupPage
        .locator('[data-testid="message-output"]')
        .textContent()) ?? '';
    const rows =
      /\{"key":"(?<key>[^"]+)","value":"(?<value>(?:[^"\\]|\\.)*)"\}/gu;
    return [...text.matchAll(rows)].map((match) => ({
      key: match.groups?.key ?? '',
      value: match.groups?.value ?? '',
    }));
  }

  /**
   * Find the kref of a vat's root object.
   *
   * Derived rather than hardcoded: subcluster vats are launched in parallel, so
   * each vat's root is exported whenever its own launch finishes, and which of
   * `ko5`/`ko6` belongs to Bob and which to Carol changes between runs. The vat
   * ids themselves are stable, being handed out in config order.
   *
   * @param dump - The kv pairs to search.
   * @param vatId - The vat whose root is wanted.
   * @returns Its root object's kref.
   */
  function rootKrefOf(
    dump: { key: string; value: string }[],
    vatId: string,
  ): string {
    const owned = dump.find(
      ({ key, value }) => key.endsWith('.owner') && value === vatId,
    );
    expect(owned, `no object owned by ${vatId}`).toBeDefined();
    return (owned as { key: string }).key.replace('.owner', '');
  }

  /**
   * Find the kref of the promise a vat is the subject of, by its c-list entry.
   *
   * Unstable for the same reason as the roots: `kp3` and `kp4` are allocated as
   * the bootstrap's calls to Bob and Carol are answered.
   *
   * @param dump - The kv pairs to search.
   * @param vatId - The vat whose promise is wanted.
   * @returns The promise's kref.
   */
  function promiseKrefOf(
    dump: { key: string; value: string }[],
    vatId: string,
  ): string {
    const entry = dump.find(({ key }) => key.startsWith(`${vatId}.c.kp`));
    expect(entry, `no promise in ${vatId}'s c-list`).toBeDefined();
    return (entry as { key: string }).key.slice(`${vatId}.c.`.length);
  }

  /**
   * Find the eref a vat knows a kref by.
   *
   * Needed in full rather than by prefix: a c-list entry's reverse direction is
   * keyed by eref and valued by kref, so matching on the kref alone would also
   * hit the owning vat's own entry for the same object.
   *
   * @param dump - The kv pairs to search.
   * @param vatId - The vat whose c-list to read.
   * @param kref - The kref it holds.
   * @returns The eref, e.g. `o-1`.
   */
  function erefOf(
    dump: { key: string; value: string }[],
    vatId: string,
    kref: string,
  ): string {
    const entry = dump.find(({ key }) => key === `${vatId}.c.${kref}`);
    expect(entry, `${vatId} has no c-list entry for ${kref}`).toBeDefined();
    return (entry as { value: string }).value.replace(/^R /u, '');
  }

  test('should load popup with kernel panel', async () => {
    await expect(
      popupPage.locator('button:text("Control Panel")'),
    ).toBeVisible();
    await expect(
      popupPage.locator('[data-testid="subcluster-accordion-s1"]'),
    ).toBeVisible();
    await expect(popupPage.locator('p:text("Message History")')).toBeVisible();
    await expect(
      popupPage.locator('p:text("Launch New Subcluster")'),
    ).toBeVisible();
  });

  test('should terminate a subcluster', async () => {
    // Open the subcluster accordion first
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    await expect(
      popupPage.locator('[data-testid="terminate-subcluster-button"]').first(),
    ).toBeVisible();
    await popupPage
      .locator('[data-testid="terminate-subcluster-button"]')
      .first()
      .click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Terminated subcluster');
  });

  test('should launch a new subcluster and vat within it', async () => {
    // Launch a new subcluster
    await launchSubcluster(minimalClusterConfig);
    const subcluster = popupPage.locator(
      '[data-testid="subcluster-accordion-s2"]',
    );
    await expect(subcluster).toBeVisible({
      timeout: 2000,
    });
    await expect(popupPage.locator('text=1 Vat')).toBeVisible();
    // Open the subcluster accordion to view vats
    await popupPage.locator('text=Subcluster s2 - 1 Vat').click();
    const vatTable = popupPage.locator('[data-testid="vat-table"]');
    await expect(vatTable).toBeVisible();
    await expect(vatTable.locator('tr')).toHaveCount(2);
  });

  test('should restart a vat within subcluster', async () => {
    // Open the subcluster accordion first
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    await expect(
      popupPage.locator('[data-testid="restart-vat-button"]').first(),
    ).toBeVisible();
    await popupPage
      .locator('[data-testid="restart-vat-button"]')
      .first()
      .click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Restarted vat');
  });

  test('should terminate a vat within subcluster', async () => {
    // Open the subcluster accordion first
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    await expect(
      popupPage.locator('td [data-testid="terminate-vat-button"]').first(),
    ).toBeVisible();
    await popupPage
      .locator('td [data-testid="terminate-vat-button"]')
      .first()
      .click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Terminated vat');
  });

  test('should ping a vat within subcluster', async () => {
    // Open the subcluster accordion first
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    await expect(
      popupPage.locator('[data-testid="ping-vat-button"]').first(),
    ).toBeVisible();
    await popupPage.locator('[data-testid="ping-vat-button"]').first().click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('"method": "pingVat",');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('pong');
  });

  test('should terminate all vats', async () => {
    await expect(
      popupPage.locator('button:text("Terminate All Vats")'),
    ).toBeVisible();
    await popupPage.click('button:text("Terminate All Vats")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('All vats terminated');
    await expect(popupPage.locator('table')).not.toBeVisible();
  });

  test('should clear kernel state', async () => {
    await popupPage.click('button:text("Clear All State")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('State cleared');
    await expect(popupPage.locator('table')).not.toBeVisible();
  });

  test('should collect garbage', async () => {
    await expect(
      popupPage.locator('button:text("Database Inspector")'),
    ).toBeVisible();
    await popupPage.click('button:text("Database Inspector")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('{"key":"vats.terminated","value":"[]"}');
    const dump = await readKvDump();
    const v2Root = rootKrefOf(dump, 'v2');
    const v3Root = rootKrefOf(dump, 'v3');
    const v2Promise = promiseKrefOf(dump, 'v2');
    const v3Promise = promiseKrefOf(dump, 'v3');
    const v3Values = [
      '{"key":"e.nextPromiseId.v3","value":"2"}',
      '{"key":"e.nextObjectId.v3","value":"1"}',
      `{"key":"${v3Root}.owner","value":"v3"}`,
      `{"key":"v3.c.${v3Root}","value":"R o+0"}`,
      `{"key":"v3.c.o+0","value":"${v3Root}"}`,
      `{"key":"v3.c.${v3Promise}","value":"R p-1"}`,
      `{"key":"v3.c.p-1","value":"${v3Promise}"}`,
      `{"key":"${v3Promise}.refCount","value":"2"}`,
    ];
    // Derived too: v1 imports the two roots as the bootstrap's calls are
    // answered, so which of `o-1`/`o-2` names which root varies with the same
    // launch ordering the krefs do.
    const v2Eref = erefOf(dump, 'v1', v2Root);
    const v3Eref = erefOf(dump, 'v1', v3Root);
    const v1koValues = [
      `{"key":"v1.c.${v2Root}","value":"R ${v2Eref}"}`,
      `{"key":"v1.c.${v2Eref}","value":"${v2Root}"}`,
      `{"key":"v1.c.${v3Root}","value":"R ${v3Eref}"}`,
      `{"key":"v1.c.${v3Eref}","value":"${v3Root}"}`,
    ];
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText(`{"key":"${v2Promise}.refCount","value":"2"}`);
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('{"key":"vatConfig.v3","value"');
    for (const value of v3Values) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).toContainText(value);
    }
    for (const value of v1koValues) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).toContainText(value);
    }
    // A live vat's root is pinned once, by `launchVat`, and its count is that
    // pin plus v1's import. Both are asserted only while v3 is alive, since
    // terminating it releases the pin — which is the point of the pair of
    // assertions after the termination below. Worth asserting at all because a
    // pin is the audit's own ground truth: a root that lost its pin agrees with
    // its own refcount, so the audit stays silent while the last importer's
    // drop can retire a live vat's root.
    for (const value of [
      `{"key":"pinned.${v3Root}","value":"1"}`,
      `{"key":"${v3Root}.refCount","value":"2,2"}`,
    ]) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).toContainText(value);
    }
    await popupPage.click('button:text("Control Panel")');
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    await popupPage
      .locator('[data-testid="terminate-vat-button"]')
      .last()
      .click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Terminated vat "v3"');
    await popupPage.locator('[data-testid="clear-logs-button"]').click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('');
    await popupPage.click('button:text("Database Inspector")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('{"key":"vats.terminated","value":"[\\"v3\\"]"}');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).not.toContainText('{"key":"vatConfig.v3","value"');
    for (const value of v3Values) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).toContainText(value);
    }
    // Terminating the vat released the pin its launch took, leaving the root
    // held only by v1's import — so it can now be collected once v1 lets go.
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).not.toContainText(`{"key":"pinned.${v3Root}"`);
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText(`{"key":"${v3Root}.refCount","value":"1,1"}`);
    await popupPage.click('button:text("Control Panel")');

    await popupPage.click('button:text("Collect Garbage")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Garbage collected');
    await popupPage.locator('[data-testid="clear-logs-button"]').click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('');
    await popupPage.click('button:text("Database Inspector")');
    // v3 is gone
    for (const value of v3Values) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).not.toContainText(value);
    }
    // v2/v3 vat root references still exist for v1
    for (const value of v1koValues) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).toContainText(value);
    }
    // kp4 reference dropped to 1
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText(`{"key":"${v3Promise}.refCount","value":"1"}`);
    await popupPage.click('button:text("Control Panel")');
    await popupPage.locator('[data-testid="accordion-header"]').first().click();
    // delete v1
    await popupPage
      .locator('[data-testid="terminate-vat-button"]')
      .first()
      .click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Terminated vat "v1"');
    await popupPage.click('button:text("Collect Garbage")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('Garbage collected');
    await popupPage.locator('[data-testid="clear-logs-button"]').click();
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('');
    await popupPage.click('button:text("Database Inspector")');
    await expect(
      popupPage.locator('[data-testid="message-output"]'),
    ).toContainText('{"key":"vats.terminated","value":"[]"}');
    for (const value of v1koValues) {
      await expect(
        popupPage.locator('[data-testid="message-output"]'),
      ).not.toContainText(value);
    }
  });
});
