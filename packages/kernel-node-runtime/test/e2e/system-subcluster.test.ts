import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Kernel, kunser } from '@metamask/ocap-kernel';
import type {
  SystemSubclusterConfig,
  ClusterConfig,
  KRef,
} from '@metamask/ocap-kernel';
import { delay } from '@ocap/repo-tools/test-utils';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';

import { makeTestKernel } from '../helpers/kernel.ts';

const SYSTEM_VAT_BUNDLE_URL = 'http://localhost:3000/system-vat.bundle';
const SAMPLE_VAT_BUNDLE_URL = 'http://localhost:3000/sample-vat.bundle';

describe('System Subcluster', { timeout: 30_000 }, () => {
  let kernel: Kernel | undefined;

  const makeSystemSubclusterConfig = (
    name: string,
    services: string[] = ['kernelFacet'],
  ): SystemSubclusterConfig => ({
    name,
    config: {
      bootstrap: name,
      vats: {
        [name]: {
          bundleSpec: SYSTEM_VAT_BUNDLE_URL,
          parameters: { name },
        },
      },
      ...(services.length > 0 && { services }),
    },
  });

  afterEach(async () => {
    if (kernel) {
      const stopResult = kernel.stop();
      kernel = undefined;
      await stopResult;
    }
  });

  describe('initialization', () => {
    it('launches system subcluster at kernel initialization', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      // System subcluster's bootstrap vat should be running
      expect(kernel.getVatIds().length).toBeGreaterThan(0);
    });

    it('provides bootstrap root via getSystemSubclusterRoot', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      const root = kernel.getSystemSubclusterRoot('test-system');
      expect(root).toBeDefined();
      expect(typeof root).toBe('string');
      expect(root).toMatch(/^ko\d+$/u);
    });
  });

  describe('kernel services', () => {
    it('receives kernelFacet service in bootstrap', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      const root = kernel.getSystemSubclusterRoot('test-system');
      expect(root).toBeDefined();

      const result = await kernel.queueMessage(root, 'hasKernelFacet', []);
      await delay();

      expect(kunser(result)).toBe(true);
    });

    it('queries kernel status via kernelFacet', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      const root = kernel.getSystemSubclusterRoot('test-system');
      expect(root).toBeDefined();

      const result = await kernel.queueMessage(root, 'getKernelStatus', []);
      await delay();

      const status = kunser(result) as {
        vats: unknown[];
        subclusters: unknown[];
      };
      expect(status).toBeDefined();
      expect(status.vats).toHaveLength(1);
      expect(status.subclusters).toHaveLength(1);
    });
  });

  describe('subcluster management', () => {
    it('launches subcluster via kernelFacet', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      const root = kernel.getSystemSubclusterRoot('test-system');
      expect(root).toBeDefined();

      // Get initial subcluster count
      const initialResult = await kernel.queueMessage(
        root,
        'getSubclusters',
        [],
      );
      await delay();
      const initialSubclusters = kunser(initialResult) as unknown[];
      expect(initialSubclusters).toHaveLength(1);

      // Launch a new subcluster via the system subcluster's bootstrap vat
      const config: ClusterConfig = {
        bootstrap: 'child',
        vats: {
          child: {
            bundleSpec: SAMPLE_VAT_BUNDLE_URL,
            parameters: { name: 'child-vat' },
          },
        },
      };

      await kernel.queueMessage(root, 'launchSubcluster', [config]);
      await delay();

      // Verify subcluster was created
      const afterResult = await kernel.queueMessage(root, 'getSubclusters', []);
      await delay();
      const afterSubclusters = kunser(afterResult) as unknown[];

      expect(afterSubclusters).toHaveLength(2);
    });

    it('terminates subcluster via kernelFacet', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
      );

      const root = kernel.getSystemSubclusterRoot('test-system');
      expect(root).toBeDefined();

      // Launch a subcluster to terminate
      const config: ClusterConfig = {
        bootstrap: 'child',
        vats: {
          child: {
            bundleSpec: SAMPLE_VAT_BUNDLE_URL,
            parameters: { name: 'child-vat' },
          },
        },
      };

      const launchResult = await kernel.queueMessage(root, 'launchSubcluster', [
        config,
      ]);
      await delay();
      const launchData = kunser(launchResult) as { subclusterId: string };
      const { subclusterId } = launchData;

      // Get count before termination
      const beforeResult = await kernel.queueMessage(
        root,
        'getSubclusters',
        [],
      );
      await delay();
      const beforeSubclusters = kunser(beforeResult) as unknown[];
      expect(beforeSubclusters).toHaveLength(2);

      // Terminate the subcluster
      await kernel.queueMessage(root, 'terminateSubcluster', [subclusterId]);
      await delay();

      // Verify subcluster was terminated
      const afterResult = await kernel.queueMessage(root, 'getSubclusters', []);
      await delay();
      const afterSubclusters = kunser(afterResult) as unknown[];

      expect(afterSubclusters).toHaveLength(1);
    });
  });

  describe('system subcluster persistence', () => {
    it('restores existing system subcluster on kernel restart', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'ocap-ss-'));
      const dbFilename = join(tempDir, 'kernel.db');
      try {
        let initialSubclusterId: string;
        let initialRoot: string | undefined;

        const firstKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename }),
          { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
        );
        try {
          const initialSubclusters = firstKernel.getSubclusters();
          expect(initialSubclusters).toHaveLength(1);
          initialSubclusterId = initialSubclusters[0]!.id;
          initialRoot = firstKernel.getSystemSubclusterRoot('test-system');
          expect(initialRoot).toBeDefined();
        } finally {
          await firstKernel.stop();
        }

        const secondKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename }),
          {
            resetStorage: false,
            systemSubclusters: [makeSystemSubclusterConfig('test-system')],
          },
        );
        try {
          const newSubclusters = secondKernel.getSubclusters();
          expect(newSubclusters).toHaveLength(1);
          expect(newSubclusters[0]!.id).toBe(initialSubclusterId);

          const newRoot = secondKernel.getSystemSubclusterRoot('test-system');
          expect(newRoot).toBeDefined();
          expect(newRoot).toBe(initialRoot);

          const result = await secondKernel.queueMessage(
            newRoot,
            'hasKernelFacet',
            [],
          );
          await delay();
          expect(kunser(result)).toBe(true);
        } finally {
          await secondKernel.stop();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });

    it('persists baggage data across kernel restarts', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'ocap-ss-'));
      const dbFilename = join(tempDir, 'kernel.db');
      try {
        let root: KRef | undefined;
        const testKey = 'persistent-data';
        const testValue = 'hello from first incarnation';

        const firstKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename }),
          { systemSubclusters: [makeSystemSubclusterConfig('test-system')] },
        );
        try {
          root = firstKernel.getSystemSubclusterRoot('test-system');
          expect(root).toBeDefined();

          await firstKernel.queueMessage(root, 'storeToBaggage', [
            testKey,
            testValue,
          ]);
          await delay();

          const storedResult = await firstKernel.queueMessage(
            root,
            'getFromBaggage',
            [testKey],
          );
          await delay();
          expect(kunser(storedResult)).toBe(testValue);
        } finally {
          await firstKernel.stop();
        }

        const secondKernel = await makeTestKernel(
          await makeSQLKernelDatabase({ dbFilename }),
          {
            resetStorage: false,
            systemSubclusters: [makeSystemSubclusterConfig('test-system')],
          },
        );
        try {
          const newRoot = secondKernel.getSystemSubclusterRoot('test-system');
          expect(newRoot).toBeDefined();
          expect(newRoot).toBe(root);

          const persistedResult = await secondKernel.queueMessage(
            newRoot,
            'getFromBaggage',
            [testKey],
          );
          await delay();
          expect(kunser(persistedResult)).toBe(testValue);

          const hasKeyResult = await secondKernel.queueMessage(
            newRoot,
            'hasBaggageKey',
            [testKey],
          );
          await delay();
          expect(kunser(hasKeyResult)).toBe(true);

          const noKeyResult = await secondKernel.queueMessage(
            newRoot,
            'hasBaggageKey',
            ['non-existent-key'],
          );
          await delay();
          expect(kunser(noKeyResult)).toBe(false);
        } finally {
          await secondKernel.stop();
        }
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('multiple system subclusters', () => {
    it('launches multiple system subclusters at kernel initialization', async () => {
      kernel = await makeTestKernel(
        await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
        {
          systemSubclusters: [
            makeSystemSubclusterConfig('system-1'),
            makeSystemSubclusterConfig('system-2'),
          ],
        },
      );

      // Both system subclusters should have bootstrap roots
      const root1 = kernel.getSystemSubclusterRoot('system-1');
      const root2 = kernel.getSystemSubclusterRoot('system-2');
      expect(root1).toBeDefined();
      expect(root2).toBeDefined();
      expect(root1).not.toBe(root2);

      // Both should have kernelFacet
      const result1 = await kernel.queueMessage(root1, 'hasKernelFacet', []);
      await delay();
      expect(kunser(result1)).toBe(true);

      const result2 = await kernel.queueMessage(root2, 'hasKernelFacet', []);
      await delay();
      expect(kunser(result2)).toBe(true);

      // Should have two subclusters
      expect(kernel.getSubclusters()).toHaveLength(2);
    });
  });
});
