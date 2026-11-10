import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { kunser } from '@metamask/ocap-kernel';
import { describe, expect, it } from 'vitest';

import { getBundleSpec, makeKernel, makeTestLogger } from './utils.ts';

describe('orphaned ephemeral exo', () => {
  it('rejects when provider vat restarts', async () => {
    const { logger } = makeTestLogger();
    const database = await makeSQLKernelDatabase({});
    const kernel = await makeKernel(database, true, logger);

    const { rootKref, subclusterId } = await kernel.launchSubcluster({
      bootstrap: 'consumer',
      vats: {
        provider: {
          bundleSpec: getBundleSpec('orphaned-ephemeral-provider'),
          parameters: {},
        },
        consumer: {
          bundleSpec: getBundleSpec('orphaned-ephemeral-consumer'),
          parameters: {},
        },
      },
    });
    await waitUntilQuiescent();

    // Works before restart
    const r1 = await kernel.queueMessage(rootKref, 'useEphemeral', []);
    expect(kunser(r1)).toBe(999);

    // Restart only the provider — the consumer still holds the
    // ephemeral ref, but the exo behind it no longer exists.
    const subcluster = kernel.getSubcluster(subclusterId);
    expect(subcluster).toBeDefined();
    await kernel.restartVat(subcluster!.vats.provider!);
    await waitUntilQuiescent();

    // The consumer's E(ephemeral).increment() targets an orphaned vref.
    // Liveslots in the provider throws "I don't remember allocating",
    // which terminates the provider vat. The message is retried in a new
    // crank, but the endpoint is gone — so it splats and rejects.
    await expect(
      kernel.queueMessage(rootKref, 'useEphemeral', []),
    ).rejects.toThrow('[KERNEL:OBJECT_DELETED]');
  });
});
