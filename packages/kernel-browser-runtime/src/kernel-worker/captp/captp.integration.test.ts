import { E } from '@endo/eventual-send';
import type {
  ClusterConfig,
  Kernel,
  KRef,
  SubclusterId,
  VatId,
} from '@metamask/ocap-kernel';
import { makeKernelFacet, kslot } from '@metamask/ocap-kernel';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeKernelCapTP } from './kernel-captp.ts';
import { makeBackgroundCapTP } from '../../background-captp.ts';
import type { CapTPMessage } from '../../background-captp.ts';

/**
 * Integration tests for CapTP communication between background and kernel endpoints.
 *
 * These tests validate that the two CapTP endpoints can communicate correctly
 * and that E() works properly with the kernel facet remote presence.
 */
describe('CapTP Integration', () => {
  let mockKernel: Kernel;
  let kernelCapTP: ReturnType<typeof makeKernelCapTP>;
  let backgroundCapTP: ReturnType<typeof makeBackgroundCapTP>;

  beforeEach(() => {
    // Create mock kernel with method implementations
    mockKernel = {
      getPresence: vi
        .fn()
        .mockImplementation(async (kref: KRef, iface: string) =>
          kslot(kref, iface),
        ),
      getStatus: vi.fn().mockResolvedValue({
        vats: [{ id: 'v1', name: 'test-vat' }],
        subclusters: ['sc1'],
        remoteComms: false,
      }),
      getSubcluster: vi.fn().mockReturnValue(undefined),
      getSubclusters: vi.fn().mockReturnValue([]),
      getSystemSubclusterRoot: vi.fn().mockReturnValue('ko99'),
      launchSubcluster: vi.fn().mockResolvedValue({
        subclusterId: 'sc1',
        rootKref: 'ko1',
        bootstrapResult: {
          body: '#{"result":"ok"}',
          slots: [],
        },
      }),
      pingVat: vi.fn().mockResolvedValue('pong'),
      queueMessage: vi.fn().mockResolvedValue({
        body: '#{"result":"message-sent"}',
        slots: [],
      }),
      reset: vi.fn().mockResolvedValue(undefined),
      terminateSubcluster: vi.fn().mockResolvedValue(undefined),
      registerKernelServiceObject: vi.fn(),
      provideFacet: vi.fn(),
    } as unknown as Kernel;

    // Wire up provideFacet to return a real facet backed by the mock kernel.
    // We wrap each mock method with a delegate so that harden() inside
    // makeKernelFacet (via makeDefaultExo) freezes the wrapper functions
    // instead of the original vi.fn() instances, keeping call tracking intact.
    vi.mocked(mockKernel.provideFacet).mockReturnValue(
      makeKernelFacet(
        Object.fromEntries(
          Object.entries(mockKernel)
            .filter(
              (entry): entry is [string, (...args: never[]) => unknown] =>
                typeof entry[1] === 'function',
            )
            .map(([key, fn]) => [key, (...args: never[]) => fn(...args)]),
        ) as unknown as Kernel,
      ),
    );

    // Wire up CapTP endpoints to dispatch messages synchronously to each other
    // This simulates direct message passing for testing

    // Kernel-side: exposes facet as bootstrap
    kernelCapTP = makeKernelCapTP({
      kernel: mockKernel,
      send: (message: CapTPMessage) => {
        // Dispatch synchronously for testing
        backgroundCapTP.dispatch(message);
      },
    });

    // Background-side: gets remote presence of kernel
    backgroundCapTP = makeBackgroundCapTP({
      send: (message: CapTPMessage) => {
        // Dispatch synchronously for testing
        kernelCapTP.dispatch(message);
      },
    });
  });

  describe('bootstrap', () => {
    it('background can get kernel remote presence via getKernel', async () => {
      // Request the kernel facet - with synchronous dispatch, this resolves immediately
      const kernel = await backgroundCapTP.getKernel();
      expect(kernel).toBeDefined();
    });
  });

  describe('ping', () => {
    it('e(kernel).ping() returns "pong"', async () => {
      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call ping via E()
      const result = await E(kernel).ping();
      expect(result).toBe('pong');
    });
  });

  describe('getStatus', () => {
    it('e(kernel).getStatus() returns status from mock kernel', async () => {
      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call getStatus via E()
      const result = await E(kernel).getStatus();
      expect(result).toStrictEqual({
        vats: [{ id: 'v1', name: 'test-vat' }],
        subclusters: ['sc1'],
        remoteComms: false,
      });

      expect(mockKernel.getStatus).toHaveBeenCalled();
    });
  });

  describe('launchSubcluster', () => {
    it('e(kernel).launchSubcluster() passes arguments correctly', async () => {
      const config: ClusterConfig = {
        bootstrap: 'v1',
        vats: {
          v1: {
            bundleSpec: 'test-source',
          },
        },
      };

      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call launchSubcluster via E()
      const result = await E(kernel).launchSubcluster(config);

      // The kernel facet delegates to the kernel's launchSubcluster
      expect(result).toStrictEqual({
        subclusterId: 'sc1',
        rootKref: 'ko1',
        bootstrapResult: {
          body: '#{"result":"ok"}',
          slots: [],
        },
      });

      expect(mockKernel.launchSubcluster).toHaveBeenCalledWith(config);
    });
  });

  describe('terminateSubcluster', () => {
    it('e(kernel).terminateSubcluster() delegates to kernel', async () => {
      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call terminateSubcluster via E()
      await E(kernel).terminateSubcluster('sc1' as SubclusterId);
      expect(mockKernel.terminateSubcluster).toHaveBeenCalledWith('sc1');
    });
  });

  describe('queueMessage', () => {
    it('e(kernel).queueMessage() passes arguments correctly', async () => {
      const target = 'ko1' as KRef;
      const method = 'doSomething';
      const args = ['arg1', { nested: 'value' }];

      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call queueMessage via E()
      const result = await E(kernel).queueMessage(target, method, args);
      expect(result).toStrictEqual({
        body: '#{"result":"message-sent"}',
        slots: [],
      });

      expect(mockKernel.queueMessage).toHaveBeenCalledWith(
        target,
        method,
        args,
      );
    });
  });

  describe('pingVat', () => {
    it('e(kernel).pingVat() delegates to kernel', async () => {
      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call pingVat via E()
      const result = await E(kernel).pingVat('v1' as VatId);
      expect(result).toBe('pong');

      expect(mockKernel.pingVat).toHaveBeenCalledWith('v1');
    });
  });

  describe('error propagation', () => {
    it('errors from kernel methods propagate to background', async () => {
      const error = new Error('Kernel operation failed');
      vi.mocked(mockKernel.getStatus).mockRejectedValueOnce(error);

      // Get kernel remote presence
      const kernel = await backgroundCapTP.getKernel();

      // Call getStatus which will fail
      await expect(E(kernel).getStatus()).rejects.toThrow(
        'Kernel operation failed',
      );
    });
  });
});
