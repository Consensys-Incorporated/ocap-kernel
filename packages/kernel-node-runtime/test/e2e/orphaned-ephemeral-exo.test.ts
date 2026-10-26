import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { kunser } from '@metamask/ocap-kernel';
import type { ClusterConfig } from '@metamask/ocap-kernel';
import { delay } from '@ocap/repo-tools/test-utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { makeTestKernel } from '../helpers/kernel.ts';

const PROVIDER_BUNDLE =
  'http://localhost:3000/orphaned-ephemeral-provider-vat.bundle';
const CONSUMER_BUNDLE =
  'http://localhost:3000/orphaned-ephemeral-consumer-vat.bundle';

const clusterConfig: ClusterConfig = {
  bootstrap: 'consumer',
  vats: {
    provider: {
      bundleSpec: PROVIDER_BUNDLE,
      parameters: {},
    },
    consumer: {
      bundleSpec: CONSUMER_BUNDLE,
      parameters: {},
    },
  },
};

describe('Orphaned ephemeral exo', { timeout: 30_000 }, () => {
  it('rejects when provider vat restarts', async () => {
    const tempDir = await mkdtemp(join(tmpdir(), 'ocap-ephemeral-'));
    const dbFilename = join(tempDir, 'kernel.db');
    try {
      const kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename }),
      );
      try {
        const { rootKref, subclusterId } =
          await kernel.launchSubcluster(clusterConfig);
        await delay();

        // Works before restart
        const r1 = await kernel.queueMessage(rootKref, 'useEphemeral', []);
        expect(kunser(r1)).toBe(999);

        // Restart only the provider — the consumer still holds the
        // ephemeral ref, but the exo behind it no longer exists.
        const subcluster = kernel.getSubcluster(subclusterId);
        expect(subcluster).toBeDefined();
        await kernel.restartVat(subcluster!.vats.provider!);
        await delay();

        // The consumer's E(ephemeral).increment() targets an orphaned vref.
        // Liveslots in the provider throws "I don't remember allocating",
        // which terminates the provider and rejects the caller's promise.
        // This is surfaced to the caller as an OBJECT_DELETED kernel error.
        await expect(
          kernel.queueMessage(rootKref, 'useEphemeral', []),
        ).rejects.toThrow('[KERNEL:OBJECT_DELETED]');
      } finally {
        await kernel.stop();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
