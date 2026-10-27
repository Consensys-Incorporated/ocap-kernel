import { makePromiseKit } from '@endo/promise-kit';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';

import { OcapURLManager } from './OcapURLManager.ts';
import type { RemoteHandle } from './RemoteHandle.ts';
import type { RemoteManager } from './RemoteManager.ts';
import { asKRef } from '../../../test/branded.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import type { SlotValue } from '../../liveslots/kernel-marshal.ts';
import { kslot } from '../../liveslots/kernel-marshal.ts';
import type { KernelStore } from '../../store/index.ts';
import type { KRef } from '../../types.ts';
import type { RemoteComms } from '../types.ts';

type RedeemService = {
  redeem: (url: string) => Promise<SlotValue>;
};

type IssuerService = {
  issue: (obj: unknown) => Promise<string>;
};

describe('OcapURLManager', () => {
  let ocapURLManager: OcapURLManager;
  let mockRemoteManager: RemoteManager;
  let mockRemoteComms: RemoteComms;
  let mockRemoteHandle: RemoteHandle;
  let mockFactory: ReturnType<typeof createMockRemotesFactory>;
  let mockKernelStore: KernelStore;
  // Issuing retains the target, which requires it to exist, so mint real
  // entities rather than naming krefs the kernel never had.
  let objectKRef: KRef;
  let otherObjectKRef: KRef;
  let promiseKRef: KRef;

  beforeEach(() => {
    mockFactory = createMockRemotesFactory({
      peerId: 'local-peer-id',
      remoteId: 'r1',
    });

    const mocks = mockFactory.makeOcapURLManagerMocks();
    mockRemoteComms = mocks.remoteComms;
    mockRemoteHandle = mocks.remoteHandle;
    mockKernelStore = mocks.kernelStore;
    objectKRef = mockKernelStore.initKernelObject('kernel');
    otherObjectKRef = mockKernelStore.initKernelObject('kernel');
    [promiseKRef] = mockKernelStore.initKernelPromise();
    mockRemoteManager = mocks.remoteManager as unknown as RemoteManager;

    // Override specific mock behaviors for this test
    vi.spyOn(mockRemoteComms, 'issueOcapURL').mockImplementation(
      async (): Promise<string> => 'ocap:abc123@local-peer-id',
    );
    vi.spyOn(mockRemoteComms, 'redeemLocalOcapURL').mockImplementation(
      async (): Promise<KRef> => asKRef('ko123'),
    );
    vi.spyOn(mockRemoteHandle, 'redeemOcapURL').mockImplementation(
      async (): Promise<KRef> => asKRef('ko456'),
    );

    ocapURLManager = new OcapURLManager({
      remoteManager: mockRemoteManager,
      kernelStore: mockKernelStore,
    });
  });

  describe('service creation', () => {
    it('creates issuer and redemption services', () => {
      const services = ocapURLManager.getServices();

      expect(services.issuerService).toBeDefined();
      expect(services.issuerService.name).toBe('ocapURLIssuerService');
      expect(services.issuerService.service).toBeDefined();

      expect(services.redemptionService).toBeDefined();
      expect(services.redemptionService.name).toBe('ocapURLRedemptionService');
      expect(services.redemptionService.service).toBeDefined();
    });

    it('returns the same service instances', () => {
      const services1 = ocapURLManager.getServices();
      const services2 = ocapURLManager.getServices();

      expect(services1.issuerService.service).toBe(
        services2.issuerService.service,
      );
      expect(services1.redemptionService.service).toBe(
        services2.redemptionService.service,
      );
    });

    it('gets issuer service directly', () => {
      const issuerService = ocapURLManager.getIssuerService();
      const services = ocapURLManager.getServices();

      expect(issuerService).toBe(services.issuerService.service);
    });

    it('gets redemption service directly', () => {
      const redemptionService = ocapURLManager.getRedemptionService();
      const services = ocapURLManager.getServices();

      expect(redemptionService).toBe(services.redemptionService.service);
    });
  });

  describe('issueOcapURL', () => {
    it('retains the target, so garbage collection cannot take it', async () => {
      // The URL is the only holder, and it lives outside the store's reference
      // graph, so without the pin the target collects and the URL goes dead.
      mockKernelStore.incrementRefCount(objectKRef, 'queue|slot');
      await ocapURLManager.issueOcapURL(objectKRef);
      mockKernelStore.decrementRefCount(objectKRef, 'deliver|send|slot');

      expect(mockKernelStore.isObjectPinned(objectKRef)).toBe(true);
      expect(mockKernelStore.getOcapURLObjects()).toStrictEqual([objectKRef]);
      mockKernelStore.collectGarbage();
      expect([...mockKernelStore.getGCActions()]).toStrictEqual([]);
      expect(mockKernelStore.kernelRefExists(objectKRef)).toBe(true);
    });

    it('counts a retention per URL naming the target, on the one pin', async () => {
      await ocapURLManager.issueOcapURL(objectKRef);
      await ocapURLManager.issueOcapURL(objectKRef);

      expect(mockKernelStore.getOcapURLIssuanceCount(objectKRef)).toBe(2);
      expect(mockKernelStore.getPinnedObjects()).toStrictEqual([objectKRef]);
      expect(mockKernelStore.getObjectRefCount(objectKRef)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('releases the retention when minting the URL fails', async () => {
      // No URL exists to depend on the pin, and nothing else would ever release
      // it: the rejection is reported to the caller, not thrown out of a crank.
      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockRejectedValue(
        new Error('Issue failed'),
      );

      await expect(ocapURLManager.issueOcapURL(objectKRef)).rejects.toThrow(
        'Issue failed',
      );

      expect(mockKernelStore.isObjectPinned(objectKRef)).toBe(false);
      expect(mockKernelStore.getOcapURLObjects()).toStrictEqual([]);
      expect(mockKernelStore.getObjectRefCount(objectKRef)).toStrictEqual({
        reachable: 0,
        recognizable: 0,
      });
    });

    it('keeps the retention a URL already issued depends on', async () => {
      await ocapURLManager.issueOcapURL(objectKRef);
      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockRejectedValue(
        new Error('Issue failed'),
      );

      await expect(ocapURLManager.issueOcapURL(objectKRef)).rejects.toThrow(
        'Issue failed',
      );

      expect(mockKernelStore.isObjectPinned(objectKRef)).toBe(true);
      expect(mockKernelStore.getOcapURLObjects()).toStrictEqual([objectKRef]);
    });

    it('keeps the retention of a URL minted while a failing issuance was in flight', async () => {
      // Minting awaits, so a second issuance for the same target can run to
      // completion inside the first's window. The first's failure may only
      // release its own retention, not the one the second's live URL needs.
      const firstMint = makePromiseKit<string>();
      vi.spyOn(mockRemoteComms, 'issueOcapURL')
        .mockImplementationOnce(async () => await firstMint.promise)
        .mockImplementationOnce(async () => 'ocap:def456@local-peer-id');

      const failing = ocapURLManager.issueOcapURL(objectKRef);
      const url = await ocapURLManager.issueOcapURL(objectKRef);
      firstMint.reject(new Error('Issue failed'));

      await expect(failing).rejects.toThrow('Issue failed');
      expect(url).toBe('ocap:def456@local-peer-id');
      expect(mockKernelStore.isObjectPinned(objectKRef)).toBe(true);
      expect(mockKernelStore.getOcapURLObjects()).toStrictEqual([objectKRef]);
      expect(mockKernelStore.getObjectRefCount(objectKRef)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    });

    it('refuses to issue a URL for a kref the kernel has deleted', async () => {
      mockKernelStore.deleteKernelObject(objectKRef);

      await expect(ocapURLManager.issueOcapURL(objectKRef)).rejects.toThrow(
        `cannot issue an ocap URL for deleted kref "${objectKRef}"`,
      );
      expect(mockRemoteComms.issueOcapURL).not.toHaveBeenCalled();
    });

    it('issues OCAP URL for a kref', async () => {
      const kref = objectKRef;
      const url = await ocapURLManager.issueOcapURL(kref);

      expect(url).toBe('ocap:abc123@local-peer-id');
      expect(mockRemoteComms.issueOcapURL).toHaveBeenCalledWith(kref);
    });

    it('throws if remote identity is not initialized', async () => {
      (mockRemoteManager.getRemoteIdentity as Mock).mockImplementation(() => {
        throw new Error('Remote identity not initialized');
      });

      await expect(
        ocapURLManager.issueOcapURL(asKRef('ko123')),
      ).rejects.toThrow('Remote identity not initialized');
    });
  });

  describe('redeemOcapURL', () => {
    it('redeems local OCAP URL', async () => {
      const url = 'ocap:abc123@local-peer-id';
      const kref = await ocapURLManager.redeemOcapURL(url);

      expect(kref).toBe('ko123');
      expect(mockRemoteComms.redeemLocalOcapURL).toHaveBeenCalledWith(url);
      expect(mockRemoteManager.withRemote).not.toHaveBeenCalled();
    });

    it('redeems remote OCAP URL', async () => {
      const url = 'ocap:def456@remote-peer-id';
      const kref = await ocapURLManager.redeemOcapURL(url);

      expect(kref).toBe('ko456');
      expect(mockRemoteComms.redeemLocalOcapURL).not.toHaveBeenCalled();
      expect(mockRemoteManager.withRemote).toHaveBeenCalledWith(
        'remote-peer-id',
        { hints: [], use: expect.any(Function) },
      );
      expect(mockRemoteHandle.redeemOcapURL).toHaveBeenCalledWith(url);
    });

    it('passes parsed hints to withRemote for remote OCAP URL', async () => {
      const url = 'ocap:def456@remote-peer-id,relay1,relay2';
      const kref = await ocapURLManager.redeemOcapURL(url);

      expect(kref).toBe('ko456');
      expect(mockRemoteManager.withRemote).toHaveBeenCalledWith(
        'remote-peer-id',
        { hints: ['relay1', 'relay2'], use: expect.any(Function) },
      );
      expect(mockRemoteHandle.redeemOcapURL).toHaveBeenCalledWith(url);
    });

    it('calls addKnownRelays with hints when redeeming a remote URL', async () => {
      const url = 'ocap:def456@remote-peer-id,relay1,relay2';
      await ocapURLManager.redeemOcapURL(url);

      expect(mockRemoteComms.addKnownRelays).toHaveBeenCalledWith([
        'relay1',
        'relay2',
      ]);
    });

    it('does not call addKnownRelays when redeeming a local URL', async () => {
      const url = 'ocap:abc123@local-peer-id';
      await ocapURLManager.redeemOcapURL(url);

      expect(mockRemoteComms.addKnownRelays).not.toHaveBeenCalled();
    });

    it('throws for invalid OCAP URL', async () => {
      await expect(ocapURLManager.redeemOcapURL('invalid-url')).rejects.toThrow(
        'unparseable URL',
      );
    });

    it('throws if remote identity is not initialized', async () => {
      (mockRemoteManager.getRemoteIdentity as Mock).mockImplementation(() => {
        throw new Error('Remote identity not initialized');
      });

      await expect(
        ocapURLManager.redeemOcapURL('ocap:abc123@local-peer-id'),
      ).rejects.toThrow('Remote identity not initialized');
    });
  });

  describe('issuer service', () => {
    it('issues URL through issuer service with valid remotable', async () => {
      // Create a valid remotable object that krefOf can extract a kref from
      const kref = objectKRef;
      const remotableObj = kslot(kref, 'TestInterface');

      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockResolvedValue(
        `ocap:issued@local-peer-id`,
      );

      const services = ocapURLManager.getServices();
      const issuerService = services.issuerService.service as IssuerService;

      const url = await issuerService.issue(remotableObj);

      expect(url).toBe('ocap:issued@local-peer-id');
      expect(mockRemoteComms.issueOcapURL).toHaveBeenCalledWith(kref);
    });

    it('issues URL through issuer service with promise kref', async () => {
      // Create a promise-type kref (starts with 'p', 'kp', or 'rp')
      const promiseKref = promiseKRef;
      const promiseObj = kslot(promiseKref);

      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockResolvedValue(
        `ocap:promise@local-peer-id`,
      );

      const services = ocapURLManager.getServices();
      const issuerService = services.issuerService.service as IssuerService;

      const url = await issuerService.issue(promiseObj);

      expect(url).toBe('ocap:promise@local-peer-id');
      expect(mockRemoteComms.issueOcapURL).toHaveBeenCalledWith(promiseKref);
    });

    it('issues URL through issuer service', async () => {
      // Since we're testing integration with krefOf which requires a special
      // object structure, we'll test the underlying mechanism instead.
      // The issuer service is already tested implicitly through other tests.

      // Test that issueOcapURL is called correctly directly
      const kref = objectKRef;
      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockResolvedValue(
        `ocap:issued@local-peer-id`,
      );

      const url = await ocapURLManager.issueOcapURL(kref);

      expect(url).toBe('ocap:issued@local-peer-id');
      expect(mockRemoteComms.issueOcapURL).toHaveBeenCalledWith(kref);
    });

    it.each([
      { input: { foo: 'bar' }, description: 'plain object' },
      { input: undefined, description: 'undefined' },
      { input: null, description: 'null' },
    ])(
      'throws error for non-remotable $description in issuer service',
      async ({ input }) => {
        const services = ocapURLManager.getServices();
        const issuerService = services.issuerService.service as IssuerService;

        await expect(issuerService.issue(input)).rejects.toThrow(
          'Argument must be a remotable',
        );
      },
    );
  });

  describe('redemption service', () => {
    it('redeems URL through redemption service', async () => {
      const services = ocapURLManager.getServices();
      const redemptionService = services.redemptionService
        .service as RedeemService;

      const url = 'ocap:abc123@local-peer-id';
      const slotValue = await redemptionService.redeem(url);

      // kslot('ko123') creates a slot value for the kref
      expect(slotValue).toStrictEqual(kslot(asKRef('ko123')));
      expect(mockRemoteComms.redeemLocalOcapURL).toHaveBeenCalledWith(url);
    });

    it('handles remote URL in redemption service', async () => {
      const services = ocapURLManager.getServices();
      const redemptionService = services.redemptionService
        .service as RedeemService;

      const url = 'ocap:def456@remote-peer-id';
      const slotValue = await redemptionService.redeem(url);

      expect(slotValue).toStrictEqual(kslot(asKRef('ko456')));
      expect(mockRemoteHandle.redeemOcapURL).toHaveBeenCalledWith(url);
    });

    it('throws for invalid URL in redemption service', async () => {
      const services = ocapURLManager.getServices();
      const redemptionService = services.redemptionService
        .service as RedeemService;

      await expect(redemptionService.redeem('not-a-url')).rejects.toThrow(
        'unparseable URL',
      );
    });
  });

  describe('integration scenarios', () => {
    it('handles round-trip issue and redeem', async () => {
      // Issue a URL
      const kref = objectKRef;
      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockResolvedValue(
        'ocap:xyz789@local-peer-id',
      );
      const issuedUrl = await ocapURLManager.issueOcapURL(kref);

      // Redeem the same URL
      vi.spyOn(mockRemoteComms, 'redeemLocalOcapURL').mockResolvedValue(kref);
      const redeemedKref = await ocapURLManager.redeemOcapURL(issuedUrl);

      expect(redeemedKref).toBe(kref);
    });

    it('handles multiple simultaneous operations', async () => {
      const promises = [
        ocapURLManager.issueOcapURL(objectKRef),
        ocapURLManager.issueOcapURL(otherObjectKRef),
        ocapURLManager.redeemOcapURL('ocap:abc@local-peer-id'),
        ocapURLManager.redeemOcapURL('ocap:def@remote-peer-id'),
      ];

      const results = await Promise.all(promises);

      expect(results).toHaveLength(4);
      expect(mockRemoteComms.issueOcapURL).toHaveBeenCalledTimes(2);
      expect(mockRemoteComms.redeemLocalOcapURL).toHaveBeenCalledTimes(1);
      expect(mockRemoteHandle.redeemOcapURL).toHaveBeenCalledTimes(1);
    });
  });

  describe('error handling', () => {
    it('propagates errors from remote comms issue', async () => {
      vi.spyOn(mockRemoteComms, 'issueOcapURL').mockRejectedValue(
        new Error('Issue failed'),
      );

      await expect(ocapURLManager.issueOcapURL(objectKRef)).rejects.toThrow(
        'Issue failed',
      );
    });

    it('propagates errors from local redeem', async () => {
      vi.spyOn(mockRemoteComms, 'redeemLocalOcapURL').mockRejectedValue(
        new Error('Redeem failed'),
      );

      await expect(
        ocapURLManager.redeemOcapURL('ocap:abc@local-peer-id'),
      ).rejects.toThrow('Redeem failed');
    });

    it('propagates errors from remote redeem', async () => {
      vi.spyOn(mockRemoteHandle, 'redeemOcapURL').mockRejectedValue(
        new Error('Remote redeem failed'),
      );

      await expect(
        ocapURLManager.redeemOcapURL('ocap:abc@remote-peer-id'),
      ).rejects.toThrow('Remote redeem failed');
    });
  });
});
