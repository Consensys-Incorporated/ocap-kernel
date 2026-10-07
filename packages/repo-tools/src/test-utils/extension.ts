import { chromium, test } from '@playwright/test';
import type { BrowserContext, ConsoleMessage, Page } from '@playwright/test';
import { appendFileSync } from 'node:fs';
import { mkdir, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

// CDP event types for Runtime domain
// These are simplified versions of the Chrome DevTools Protocol types
type CdpRemoteObject = {
  type: string;
  value?: unknown;
  description?: string;
};

type CdpExecutionContextCreatedEvent = {
  context: {
    id: number;
    origin: string;
    auxData?: { frameId?: string };
  };
};

type CdpConsoleAPICalledEvent = {
  type: string;
  args: CdpRemoteObject[];
  executionContextId: number;
};

export const sessionPath = path.resolve(os.tmpdir(), 'ocap-test');

// Run ID is generated once per Playwright invocation (per worker process)
// This allows associating all test log files from the same run
const runId = new Date()
  .toISOString()
  .slice(0, -5) // Remove ".123Z"
  .replace(/[:.]/gu, '-'); // Make filename-safe

type Options = {
  contextId?: string | undefined;
  extensionPath: string;
  onPageLoad?: (popupPage: Page) => Promise<void> | undefined;
};

/**
 * Creates an extension context, extension ID, and popup page.
 *
 * @param options - Options for the extension
 * @param options.contextId - Optional context identifier to create separate browser contexts.
 * If not provided, uses the TEST_WORKER_INDEX environment variable.
 * @param options.extensionPath - The path to the extension dist folder.
 * @param options.onPageLoad - Optional callback to run after the extension is loaded. Useful for
 * e.g. waiting for components to be visible before proceeding with a test.
 * @returns The extension context, extension ID, popup page, log file path, and cleanup function
 */
export const makeLoadExtension = async ({
  contextId,
  extensionPath,
  onPageLoad = async () => Promise.resolve(),
}: Options): Promise<{
  browserContext: BrowserContext;
  extensionId: string;
  popupPage: Page;
  logFilePath: string;
  attachLogs: () => Promise<void>;
}> => {
  const workerIndex = process.env.TEST_WORKER_INDEX ?? '0';
  // Use provided contextId or fall back to workerIndex for separate user data dirs
  const effectiveContextId = contextId ?? workerIndex;
  const userDataDir = path.join(sessionPath, effectiveContextId);
  await rm(userDataDir, { recursive: true, force: true });

  // Set up log file for capturing console output from extension contexts
  const packageRoot = path.dirname(extensionPath); // extensionPath is <package>/dist
  const logsDir = path.join(packageRoot, 'logs');
  await mkdir(logsDir, { recursive: true });
  const testTitle = test
    .info()
    .titlePath.join('-')
    .replace(/[^a-zA-Z0-9-]/gu, '_'); // Make filename-safe
  const logFilePath = path.join(logsDir, `${runId}-${testTitle}.log`);

  /**
   * Attaches the log file to test results. Call this at the end of your test
   * to include console logs in the Playwright HTML report.
   */
  const attachLogs = async (): Promise<void> => {
    let content: string;
    try {
      content = await readFile(logFilePath, 'utf-8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    await test.info().attach('console-logs', {
      body: content,
      contentType: 'text/plain',
    });
  };

  /**
   * Write a raw log entry (for CDP events where we don't have a ConsoleMessage).
   *
   * @param source - The source identifier for the log.
   * @param type - The console method type.
   * @param text - The log message text.
   */
  const writeRawLog = (source: string, type: string, text: string): void => {
    const logTimestamp = new Date().toISOString().slice(0, -5);
    // eslint-disable-next-line n/no-sync
    appendFileSync(
      logFilePath,
      `[${logTimestamp}] [${source}] [${type}] ${text}\n`,
    );
  };

  const writeLog = (source: string, consoleMessage: ConsoleMessage): void => {
    writeRawLog(source, consoleMessage.type(), consoleMessage.text());
  };

  const browserArgs = [
    `--disable-features=ExtensionDisableUnsupportedDeveloper`,
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`,
    '--lang=en-US',
  ];

  const isHeadless = process.env.npm_lifecycle_event === 'test:e2e';
  if (isHeadless) {
    browserArgs.push(`--headless=new`);
  }

  // Launch the browser with the extension
  const browserContext = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: browserArgs,
  });

  // Capture background service worker console logs
  browserContext.on('serviceworker', (worker) => {
    worker.on('console', (consoleMessage) =>
      writeLog('background', consoleMessage),
    );
  });

  // Capture console logs from extension pages (offscreen document, etc.)
  // Note: Pages may start at about:blank, so we attach the listener and check URL in the handler
  browserContext.on('page', (page) => {
    page.on('console', (consoleMessage) => {
      if (page.url().includes('offscreen.html')) {
        writeLog('offscreen', consoleMessage);
      }
    });

    // Capture Web Worker console logs (e.g., kernel worker)
    page.on('worker', (worker) => {
      worker.on('console', (consoleMessage) => {
        writeLog('kernel-worker', consoleMessage);
      });
    });

    // Set up CDP to capture iframe console logs (vat iframes)
    // We need to do this because Playwright doesn't have frame.on('console')
    setupCdpForIframeConsoleLogs(page, writeRawLog).catch(
      // eslint-disable-next-line no-console
      (error) => console.warn('Failed to set up CDP for iframe logs:', error),
    );
  });

  // Wait for the extension to be loaded
  await new Promise((resolve) => setTimeout(resolve, 1000));

  const chromeExtensionURLIdMatcher = /^chrome-extension:\/\/([^/]+)/u;
  const serviceWorkers = browserContext.serviceWorkers();
  const extensionId = serviceWorkers[0]
    ?.url()
    .match(chromeExtensionURLIdMatcher)?.[1];

  if (!extensionId) {
    throw new Error('Extension ID not found');
  }

  const popupPage = await browserContext.newPage();
  popupPage.on('console', (consoleMessage) =>
    writeLog('popup', consoleMessage),
  );
  await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
  await onPageLoad(popupPage);

  return { browserContext, extensionId, popupPage, logFilePath, attachLogs };
};

/**
 * Sets up Chrome DevTools Protocol (CDP) to capture console logs from iframes.
 * Playwright doesn't provide `frame.on('console')`, so we use CDP's Runtime domain
 * to listen for console API calls from all execution contexts including iframes.
 *
 * @param page - The Playwright page to set up CDP for.
 * @param writeRawLog - Function to write raw log entries.
 */
async function setupCdpForIframeConsoleLogs(
  page: Page,
  writeRawLog: (source: string, type: string, text: string) => void,
): Promise<void> {
  // Pages may start at about:blank, so wait for navigation to complete
  // Only set up CDP for pages that might have iframes (offscreen document)
  try {
    await page.waitForURL('**/offscreen.html', { timeout: 5000 });
  } catch {
    // Page didn't navigate to offscreen.html, skip CDP setup
    return;
  }

  const cdpSession = await page.context().newCDPSession(page);

  // Enable Runtime domain to receive console events
  await cdpSession.send('Runtime.enable');

  // Track execution contexts to identify iframe sources
  const executionContexts = new Map<number, string>();

  // Track the main frame's execution context ID
  // The first context created with the extension's origin is the main frame
  let mainFrameContextId: number | undefined;

  // Listen for new execution contexts (iframes get their own context)
  cdpSession.on(
    'Runtime.executionContextCreated',
    (event: CdpExecutionContextCreatedEvent) => {
      const { id, origin, auxData } = event.context;
      const frameId = auxData?.frameId;

      // Track the main frame's context ID when we see it
      // The frameId from CDP won't match Playwright's _guid directly,
      // but the main frame context is typically the first one with the page's origin
      if (
        mainFrameContextId === undefined &&
        origin.includes('chrome-extension')
      ) {
        mainFrameContextId = id;
      }

      // Build source identifier for iframes (contexts with a frameId)
      const source = frameId ? `iframe-${frameId.slice(0, 8)}` : `ctx-${id}`;
      executionContexts.set(id, frameId ? source : origin);
    },
  );

  // Listen for console API calls from all contexts (including iframes)
  cdpSession.on(
    'Runtime.consoleAPICalled',
    (event: CdpConsoleAPICalledEvent) => {
      const { type, args, executionContextId } = event;

      // Skip main frame logs - they're already captured via page.on('console')
      if (executionContextId === mainFrameContextId) {
        return;
      }

      // Format args into a readable string
      const text = args
        .map((arg) => {
          if (arg.value !== undefined) {
            return typeof arg.value === 'string'
              ? arg.value
              : JSON.stringify(arg.value);
          }
          return arg.description ?? arg.type;
        })
        .join(' ');

      // Determine the source based on execution context
      const contextSource = executionContexts.get(executionContextId);
      const source = contextSource?.startsWith('iframe')
        ? contextSource
        : `iframe-ctx-${executionContextId}`;

      writeRawLog(source, type, text);
    },
  );
}
