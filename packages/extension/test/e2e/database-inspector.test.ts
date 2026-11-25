import { test, expect } from '@playwright/test';
import type { Page, BrowserContext } from '@playwright/test';

import { loadExtension } from '../helpers.ts';

test.describe('Database Inspector', () => {
  let extensionContext: BrowserContext;
  let popupPage: Page;

  test.beforeEach(async () => {
    const extension = await loadExtension();
    extensionContext = extension.browserContext;
    popupPage = extension.popupPage;
    await popupPage.click('button:text("Database Inspector")');
    await expect(
      popupPage.locator('text=SELECT name FROM sqlite_master'),
    ).toBeVisible();
  });

  test.afterEach(async () => {
    await extensionContext.close();
  });

  test('should display database inspector with kv table', async () => {
    const tableSelect = popupPage.locator('select');
    await expect(tableSelect).toBeVisible();
    await expect(tableSelect).toHaveValue('kv');
    const table = popupPage.locator('table');
    await expect(table).toBeVisible();
    const rows = table.locator('tr');
    const rowCount = await rows.count();
    expect(rowCount).toBeGreaterThan(1);
  });

  test('should refresh table data', async () => {
    await popupPage.click('[data-testid="refresh-button"]');
    const table = popupPage.locator('table');
    await expect(table).toBeVisible();
    await expect(table).toContainText('nextVatId');
  });

  test('should execute SQL query and show results', async () => {
    // The table's own load, if still pending, would replace the results.
    await expect(popupPage.locator('table')).toContainText('nextVatId');
    await popupPage.fill(
      '[data-testid="sql-query-input"]',
      "SELECT value FROM kv WHERE key = 'nextVatId'",
    );
    await popupPage.click('[data-testid="execute-query-button"]');
    const queryResults = popupPage.locator('table');
    await expect(queryResults).toBeVisible();
    const resultCell = queryResults.locator('td').first();
    await expect(resultCell).toHaveText('4');
  });

  test('should handle invalid SQL queries', async () => {
    await popupPage.fill(
      '[data-testid="sql-query-input"]',
      'INVALID SQL QUERY',
    );
    await popupPage.click('[data-testid="execute-query-button"]');
    await expect(
      popupPage.locator('text=Failed to execute query'),
    ).toBeVisible();
  });
});
