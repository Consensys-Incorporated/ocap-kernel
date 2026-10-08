import { makeCounter } from '@metamask/kernel-utils';
import type { VatId } from '@metamask/ocap-kernel';
import { NodeWorkerDuplexStream } from '@metamask/streams';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { NodejsPlatformServices } from '../../src/kernel/PlatformServices.ts';
import { getTestWorkerFile } from '../get-test-worker.ts';

describe('NodejsPlatformServices', () => {
  const testWorkerFile = getTestWorkerFile('stream-sync');
  const vatIdCounter = makeCounter();
  const getTestVatId = (): VatId => `v${vatIdCounter()}`;

  // Track all services to ensure cleanup
  const services: NodejsPlatformServices[] = [];

  afterEach(async () => {
    // Terminate all workers to prevent dangling processes
    await Promise.all(services.map(async (service) => service.terminateAll()));
    // eslint-disable-next-line require-atomic-updates
    services.length = 0;
    vi.restoreAllMocks();
  });

  const createService = (): NodejsPlatformServices => {
    const service = new NodejsPlatformServices({
      workerFilePath: testWorkerFile,
    });
    services.push(service);
    return service;
  };

  describe('launch', () => {
    it('creates a NodeWorker and returns a NodeWorkerDuplexStream', async () => {
      const service = createService();
      const testVatId: VatId = getTestVatId();
      const stream = await service.launch(testVatId);

      expect(stream).toBeInstanceOf(NodeWorkerDuplexStream);
    });

    it('rejects if synchronize fails', async () => {
      const rejected = 'test-reject-value';

      vi.doMock('@metamask/streams', () => ({
        NodeWorkerDuplexStream: class MockNodeWorkerDuplexStream {
          synchronize = vi.fn().mockRejectedValue(rejected);
        },
      }));
      vi.resetModules();
      const NVWS = (await import('../../src/kernel/PlatformServices.ts'))
        .NodejsPlatformServices;

      const service = new NVWS({ workerFilePath: testWorkerFile });
      services.push(service);
      const testVatId: VatId = getTestVatId();
      await expect(service.launch(testVatId)).rejects.toThrow(rejected);
    });
  });

  describe('terminate', () => {
    it('terminates the target vat', async () => {
      const service = createService();
      const testVatId: VatId = getTestVatId();

      await service.launch(testVatId);
      expect(service.workers.has(testVatId)).toBe(true);

      await service.terminate(testVatId);
      expect(service.workers.has(testVatId)).toBe(false);
    });

    it('throws when terminating an unknown vat', async () => {
      const service = createService();
      const testVatId: VatId = getTestVatId();

      await expect(service.terminate(testVatId)).rejects.toThrow(
        /No worker found/u,
      );
    });
  });

  describe('terminateAll', () => {
    it('terminates all vats', async () => {
      const service = createService();
      const vatIds: VatId[] = [getTestVatId(), getTestVatId(), getTestVatId()];

      await Promise.all(
        vatIds.map(async (vatId) => await service.launch(vatId)),
      );

      expect(Array.from(service.workers.values())).toHaveLength(vatIds.length);

      await service.terminateAll();

      expect(Array.from(service.workers.values())).toHaveLength(0);
    });
  });
});
