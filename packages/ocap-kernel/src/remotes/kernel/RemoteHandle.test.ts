import type { VatOneResolution } from '@agoric/swingset-liveslots';
import type { Logger } from '@metamask/logger';
import { makeAbortSignalMock } from '@ocap/repo-tools/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RemoteHandle } from './RemoteHandle.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import type { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelStore } from '../../store/index.ts';
import type { KernelStore } from '../../store/index.ts';
import { parseRef } from '../../store/utils/parse-ref.ts';
import type { CrankResult, EndpointMessage, RRef } from '../../types.ts';
import type { RemoteComms } from '../types.ts';

let mockKernelStore: KernelStore;
let mockRemoteComms: RemoteComms;
let mockKernelQueue: KernelQueue;
const mockRemoteId = 'r0';
const mockRemotePeerId = 'remotePeerId';
let mockFactory: ReturnType<typeof createMockRemotesFactory>;

/* eslint-disable vitest/no-conditional-expect */

/**
 * Fabricate a mock remote for testing purposes
 *
 * @param logger - A logger, if you care.
 *
 * @returns a new RemoteHandle suitable for use in testing.
 */
export function makeRemote(logger?: Logger): RemoteHandle {
  return RemoteHandle.make({
    remoteId: mockRemoteId,
    peerId: mockRemotePeerId,
    kernelStore: mockKernelStore,
    kernelQueue: mockKernelQueue,
    remoteComms: mockRemoteComms,
    logger,
  });
}

/**
 * Take a message off the wire and run the crank it queues, the way the kernel's
 * message handler and the run loop do between them. A message that queues
 * nothing — a standalone acknowledgement — is handled entirely by the first
 * step.
 *
 * @param remote - The handle receiving it.
 * @param message - The message, as it arrived.
 */
async function receiveAndRunCrank(
  remote: RemoteHandle,
  message: string,
): Promise<void> {
  remote.receiveFromPeer(message);
  const queued = vi
    .mocked(mockKernelQueue.acceptRemoteInbound)
    .mock.calls.at(-1);
  if (!queued) {
    return;
  }
  const result = await remote.deliverInbound(queued[1]);
  await result.afterCommit?.();
}

/**
 * Make a delivery and run the post-commit work with it, the way the run loop
 * does. A delivery only writes its message down; the send waits for the commit.
 *
 * @param delivery - The delivery to make.
 * @returns Its crank result.
 */
async function deliverAndCommit(
  delivery: Promise<CrankResult>,
): Promise<CrankResult> {
  const result = await delivery;
  await result.afterCommit?.();
  return result;
}

describe('RemoteHandle', () => {
  beforeEach(() => {
    mockFactory = createMockRemotesFactory({
      remoteId: mockRemoteId,
      remotePeerId: mockRemotePeerId,
    });

    const mocks = mockFactory.makeRemoteHandleMocks();
    mockKernelStore = mocks.kernelStore;
    mockKernelQueue = mocks.kernelQueue;
    mockRemoteComms = mocks.remoteComms;

    // Override specific mock behaviors for this test
    const mockRedeemLocalOcapURL = vi.fn();
    mockRedeemLocalOcapURL.mockReturnValue('ko100');
    mockRemoteComms.redeemLocalOcapURL = mockRedeemLocalOcapURL;
    mockRemoteComms.getPeerId = () => 'myPeerId';
  });

  it('deliverMessage calls sendRemoteMessage with correct delivery message', async () => {
    const remote = makeRemote();
    const target: RRef = 'ro+1';
    const message: EndpointMessage = {
      methargs: { body: '["method",["arg1","arg2"]]', slots: [] },
      result: 'rp-2',
    };
    const crankResult = await deliverAndCommit(
      remote.deliverMessage(target, message),
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    // Verify the string contains the expected message content
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('deliver');
    expect(parsed.params).toStrictEqual(['message', target, message]);
    expect(crankResult).toStrictEqual({
      didDelivery: remote.remoteId,
      afterCommit: expect.any(Function),
    });
  });

  it('writes the delivery down before the crank commits, and sends it after', async () => {
    const remote = makeRemote();

    const { afterCommit } = await remote.deliverMessage('ro+1', {
      methargs: { body: '["m",[]]', slots: [] },
    } as EndpointMessage);

    // Persisted inside the crank, so a rollback takes it back with everything
    // else the crank did.
    expect(mockKernelStore.getPendingMessage(mockRemoteId, 1)).toBeDefined();
    expect(mockRemoteComms.sendRemoteMessage).not.toHaveBeenCalled();

    await afterCommit?.();

    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledOnce();
  });

  // `afterCommit` runs after the crank's transaction has been released, so a
  // write from it would autocommit on its own. Enforced rather than asserted
  // in prose. The send is made to fail, because the transport's failure
  // handling is the one part of transmitting that writes — the guard is armed
  // only for `afterCommit`'s own execution, which is the extent the contract
  // covers, and that handling runs detached from it.
  it('writes nothing to the store from afterCommit', async () => {
    const database = makeMapKernelDatabase();
    const underlying = database.kernelKVStore;
    let refuseWrites = false;
    const refuse = (what: string, key: string): void => {
      if (refuseWrites) {
        throw Error(`afterCommit wrote the kernel store: ${what} ${key}`);
      }
    };
    const kernelStore = makeKernelStore({
      ...database,
      kernelKVStore: {
        ...underlying,
        set: (key: string, value: string) => {
          refuse('set', key);
          underlying.set(key, value);
        },
        delete: (key: string) => {
          refuse('delete', key);
          underlying.delete(key);
        },
      },
    });
    const remote = RemoteHandle.make({
      remoteId: mockRemoteId,
      peerId: mockRemotePeerId,
      kernelStore,
      kernelQueue: mockKernelQueue,
      remoteComms: mockRemoteComms,
    });
    kernelStore.initEndpoint(remote.remoteId);
    vi.spyOn(mockRemoteComms, 'sendRemoteMessage').mockRejectedValue(
      new Error('network is down'),
    );

    const { afterCommit } = await remote.deliverBringOutYourDead();
    refuseWrites = true;

    await afterCommit?.();
    refuseWrites = false;

    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledOnce();
  });

  it('deliverNotify calls sendRemoteMessage with correct delivery message', async () => {
    const remote = makeRemote();
    const resolutions: VatOneResolution[] = [
      ['rp-3', false, { body: '"resolved value"', slots: [] }],
    ];

    const crankResult = await deliverAndCommit(
      remote.deliverNotify(resolutions),
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('deliver');
    expect(parsed.params).toStrictEqual(['notify', resolutions]);
    expect(crankResult).toStrictEqual({
      didDelivery: remote.remoteId,
      afterCommit: expect.any(Function),
    });
  });

  it('deliverDropExports calls sendRemoteMessage with correct delivery message', async () => {
    const remote = makeRemote();
    const rrefs: RRef[] = ['ro+4', 'ro+5'];

    const crankResult = await deliverAndCommit(
      remote.deliverDropExports(rrefs),
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('deliver');
    expect(parsed.params).toStrictEqual(['dropExports', rrefs]);
    expect(crankResult).toStrictEqual({
      didDelivery: remote.remoteId,
      afterCommit: expect.any(Function),
    });
  });

  it('deliverRetireExports calls sendRemoteMessage with correct delivery message', async () => {
    const remote = makeRemote();
    const rrefs: RRef[] = ['ro+4', 'ro+5'];

    const crankResult = await deliverAndCommit(
      remote.deliverRetireExports(rrefs),
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('deliver');
    expect(parsed.params).toStrictEqual(['retireExports', rrefs]);
    expect(crankResult).toStrictEqual({
      didDelivery: remote.remoteId,
      afterCommit: expect.any(Function),
    });
  });

  it('deliverRetireImports calls sendRemoteMessage with correct delivery message', async () => {
    const remote = makeRemote();
    const rrefs: RRef[] = ['ro+4', 'ro+5'];

    const crankResult = await deliverAndCommit(
      remote.deliverRetireImports(rrefs),
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('deliver');
    expect(parsed.params).toStrictEqual(['retireImports', rrefs]);
    expect(crankResult).toStrictEqual({
      didDelivery: remote.remoteId,
      afterCommit: expect.any(Function),
    });
  });

  describe('bringOutYourDead', () => {
    it('sends BOYD delivery to remote when locally triggered', async () => {
      const remote = makeRemote();

      const crankResult = await deliverAndCommit(
        remote.deliverBringOutYourDead(),
      );
      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
        mockRemotePeerId,
        expect.any(String),
      );
      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]![1];
      const parsed = JSON.parse(sentString);
      expect(parsed).toStrictEqual({
        seq: 1,
        method: 'deliver',
        params: ['bringOutYourDead'],
      });
      expect(crankResult).toStrictEqual({
        didDelivery: remote.remoteId,
        afterCommit: expect.any(Function),
      });
    });

    it('handles incoming BOYD by scheduling reap', async () => {
      const remote = makeRemote();

      const delivery = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['bringOutYourDead'],
      });
      await receiveAndRunCrank(remote, delivery);

      // Verify reap was scheduled by checking the reap queue
      expect(mockKernelStore.nextReapAction()).toStrictEqual({
        type: 'bringOutYourDead',
        endpointId: remote.remoteId,
      });
    });

    // The run loop is what drains an arrival, so a dead one would leave the
    // peer acknowledged by a black hole. The refusal is the queue's, at the
    // point the message is accepted rather than when its crank comes up.
    it('lets the queue refuse an arrival for a dead run loop', () => {
      const remote = makeRemote();
      const failure = new Error('Kernel run loop died; cannot accept it');
      vi.mocked(mockKernelQueue.acceptRemoteInbound).mockImplementation(() => {
        throw failure;
      });

      expect(() =>
        remote.receiveFromPeer(
          JSON.stringify({
            seq: 1,
            method: 'deliver',
            params: ['bringOutYourDead'],
          }),
        ),
      ).toThrow(failure);

      // Nothing was recorded, so the peer's retry is not a duplicate.
      expect(
        mockKernelStore.getRemoteSeqState(mockRemoteId)?.highestReceivedSeq,
      ).toBeUndefined();
    });

    it('does not send BOYD back when remotely triggered (ping-pong prevention)', async () => {
      const remote = makeRemote();

      // Receive BOYD from remote
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          method: 'deliver',
          params: ['bringOutYourDead'],
        }),
      );

      // Now local kernel calls deliverBringOutYourDead - should NOT send back
      const crankResult = await deliverAndCommit(
        remote.deliverBringOutYourDead(),
      );
      expect(mockRemoteComms.sendRemoteMessage).not.toHaveBeenCalled();
      expect(crankResult).toStrictEqual({ didDelivery: remote.remoteId });
    });

    it('clears flag after skipping echo (next local BOYD sends normally)', async () => {
      const remote = makeRemote();

      // Receive BOYD from remote
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          method: 'deliver',
          params: ['bringOutYourDead'],
        }),
      );

      // First local BOYD - suppressed
      await deliverAndCommit(remote.deliverBringOutYourDead());
      expect(mockRemoteComms.sendRemoteMessage).not.toHaveBeenCalled();

      // Second local BOYD - should send normally (flag was cleared)
      await deliverAndCommit(remote.deliverBringOutYourDead());
      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
        mockRemotePeerId,
        expect.any(String),
      );
      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]![1];
      const parsed = JSON.parse(sentString);
      expect(parsed).toStrictEqual({
        seq: 1,
        ack: 1,
        method: 'deliver',
        params: ['bringOutYourDead'],
      });
    });

    it('tracks correct seq/ack on BOYD messages', async () => {
      const remote = makeRemote();

      // Receive a non-BOYD message to set up ack tracking
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 3,
          method: 'deliver',
          params: ['notify', resolutions],
        }),
      );

      // Send a non-BOYD message first to consume seq 1
      await deliverAndCommit(
        remote.deliverNotify([['rp+1', false, { body: '"value"', slots: [] }]]),
      );

      // Now send BOYD - should get seq 2 with ack 3
      await deliverAndCommit(remote.deliverBringOutYourDead());

      const { calls } = vi.mocked(mockRemoteComms.sendRemoteMessage).mock;
      // Second call is the BOYD (first was the notify)
      const parsed = JSON.parse(calls[1]![1]);
      expect(parsed).toStrictEqual({
        seq: 2,
        ack: 3,
        method: 'deliver',
        params: ['bringOutYourDead'],
      });
    });

    it('persists BOYD message for retransmission', async () => {
      const remote = makeRemote();

      await deliverAndCommit(remote.deliverBringOutYourDead());

      // Verify message was persisted
      const pendingMsgString = mockKernelStore.getPendingMessage(
        mockRemoteId,
        1,
      );
      expect(pendingMsgString).toBeDefined();
      expect(pendingMsgString).toContain('"bringOutYourDead"');
      expect(pendingMsgString).toContain('"seq":1');
    });
  });

  it('redeemOcapURL calls sendRemoteMessage correctly and handles expected reply (success)', async () => {
    const remote = makeRemote();
    const mockOcapURL = 'as if it was a URL';
    const mockURLResolutionRRef = 'ro+6';
    const mockURLResolutionKRef = 'ko1';
    const expectedReplyKey = '1';

    const urlPromise = remote.redeemOcapURL(mockOcapURL);
    // Reply includes seq since all incoming messages have seq
    const redeemURLReply = {
      seq: 1,
      method: 'redeemURLReply',
      params: [true, expectedReplyKey, mockURLResolutionRRef],
    };
    await receiveAndRunCrank(remote, JSON.stringify(redeemURLReply));
    const kref = await urlPromise;
    expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
      mockRemotePeerId,
      [],
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('redeemURL');
    expect(parsed.params).toStrictEqual([mockOcapURL, expectedReplyKey]);
    expect(kref).toBe(mockURLResolutionKRef);
    expect(
      mockKernelStore.translateRefEtoK(remote.remoteId, mockURLResolutionRRef),
    ).toBe(mockURLResolutionKRef);
  });

  it('redeemOcapURL calls sendRemoteMessage correctly and handles expected reply (failure)', async () => {
    const remote = makeRemote();
    const mockOcapURL = 'as if it was a URL';
    const expectedReplyKey = '1';

    const urlPromise = remote.redeemOcapURL(mockOcapURL);
    // Reply includes seq since all incoming messages have seq
    const redeemURLReply = {
      seq: 1,
      method: 'redeemURLReply',
      params: [false, expectedReplyKey],
    };
    await receiveAndRunCrank(remote, JSON.stringify(redeemURLReply));
    expect(mockRemoteComms.registerLocationHints).toHaveBeenCalledWith(
      mockRemotePeerId,
      [],
    );
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
      mockRemotePeerId,
      expect.any(String),
    );
    const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
      .calls[0]![1];
    const parsed = JSON.parse(sentString);
    expect(parsed.seq).toBe(1);
    expect(parsed.method).toBe('redeemURL');
    expect(parsed.params).toStrictEqual([mockOcapURL, expectedReplyKey]);
    await expect(urlPromise).rejects.toThrow(
      `vitest ignores this string but lint complains if it's not here`,
    );
  });

  it('deliverInbound throws for unknown URL redemption reply key', async () => {
    const remote = makeRemote();
    const unknownReplyKey = 'unknown-key';

    // Include seq since all incoming messages have seq
    const redeemURLReply = {
      seq: 1,
      method: 'redeemURLReply',
      params: [true, unknownReplyKey, 'ro+1'],
    };

    await expect(
      remote.deliverInbound(JSON.stringify(redeemURLReply)),
    ).rejects.toThrow(`unknown URL redemption reply key ${unknownReplyKey}`);
  });

  it('takes delivery of deliver message', async () => {
    const remote = makeRemote();
    const targetRRef = 'ro+1';
    const targetKRef = 'ko1';
    const resultRRef = 'rp+2';
    const resultKRef = 'kp1';
    const message: EndpointMessage = {
      methargs: { body: '["method",["arg1","arg2"]]', slots: [] },
      result: resultRRef,
    };
    // Include seq since all incoming messages have seq
    const delivery = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['message', targetRRef, message],
    });
    await receiveAndRunCrank(remote, delivery);
    expect(mockKernelQueue.enqueueSend).toHaveBeenCalledWith(targetKRef, {
      methargs: message.methargs,
      result: resultKRef,
    });
    expect(mockKernelStore.translateRefEtoK(remote.remoteId, targetRRef)).toBe(
      targetKRef,
    );
    expect(mockKernelStore.translateRefEtoK(remote.remoteId, resultRRef)).toBe(
      resultKRef,
    );
  });

  it('takes delivery of deliver notify', async () => {
    const remote = makeRemote();
    const promiseRRef = 'rp+3';
    const promiseKRef = 'kp1';
    const resolutions: VatOneResolution[] = [
      [promiseRRef, false, { body: '"resolved value"', slots: [] }],
    ];
    // Include seq since all incoming messages have seq
    const notify = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['notify', resolutions],
    });
    await receiveAndRunCrank(remote, notify);
    expect(mockKernelQueue.resolvePromises).toHaveBeenCalledWith(
      remote.remoteId,
      [[promiseKRef, false, { body: '"resolved value"', slots: [] }]],
    );
  });

  it('takes delivery of deliver dropExports', async () => {
    const remote = makeRemote();

    // Note that vat v1 does not exist; we're just pretending the test object
    // came from there (because it had to come from *somewhere*).
    const koref = mockKernelStore.initKernelObject('v1');
    const [kpref] = mockKernelStore.initKernelPromise();
    mockKernelStore.initEndpoint(remote.remoteId);

    // Pretend these refs had earlier been imported into the test remote from
    // our kernel (as if they had, say, appeared in message slots) and thence were
    // exported at the remote end.  This way they'll be here to be dropped when
    // a request to do so is "received".
    const roref = mockKernelStore.translateRefKtoE(
      remote.remoteId,
      koref,
      true,
    );
    const rpref = mockKernelStore.translateRefKtoE(
      remote.remoteId,
      kpref,
      true,
    );

    const drops = [
      mockKernelStore.invertRRef(roref),
      mockKernelStore.invertRRef(rpref),
    ];

    const krefs = drops.map((rref) => {
      const result = mockKernelStore.translateRefEtoK(remote.remoteId, rref);
      return result;
    });
    for (const kref of krefs) {
      const { isPromise } = parseRef(kref);
      if (isPromise) {
        // 1 for the unsettled promise, 1 for the remote's c-list entry
        expect(mockKernelStore.getRefCount(kref)).toBe(2);
      } else {
        expect(mockKernelStore.getObjectRefCount(kref)).toStrictEqual({
          reachable: 1,
          recognizable: 1,
        });
      }
    }

    // Now have the "other end" drop them (include seq for incoming message)
    const dropExports = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['dropExports', drops],
    });
    await receiveAndRunCrank(remote, dropExports);

    for (const kref of krefs) {
      const { isPromise } = parseRef(kref);
      if (isPromise) {
        expect(mockKernelStore.getRefCount(kref)).toBe(2);
      } else {
        expect(mockKernelStore.getObjectRefCount(kref)).toStrictEqual({
          reachable: 0,
          recognizable: 1,
        });
      }
    }
  });

  it('takes delivery of deliver retireExports', async () => {
    const remote = makeRemote();

    // Note that vat v1 does not exist; we're just pretending the test object
    // came from there (because it had to come from *somewhere*).
    const koref = mockKernelStore.initKernelObject('v1');
    mockKernelStore.initEndpoint(remote.remoteId);

    // Pretend this ref had earlier been imported into the test remote from our
    // kernel (as if it had, say, appeared in message slots) and thence wwas
    // exported at the remote end.  This way it'll be here to be retired when a
    // request to do so is "received".
    const roref = mockKernelStore.translateRefKtoE(
      remote.remoteId,
      koref,
      true,
    );

    const toRetireRRef = mockKernelStore.invertRRef(roref);

    const kref = mockKernelStore.translateRefEtoK(
      remote.remoteId,
      toRetireRRef,
    );
    expect(mockKernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });

    // Before we can retire, we have to drop, so pretend that happened too
    mockKernelStore.clearReachableFlag(remote.remoteId, kref);

    // Now have the "other end" retire them (include seq for incoming message)
    const retireExports = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['retireExports', [toRetireRRef]],
    });
    await receiveAndRunCrank(remote, retireExports);

    expect(mockKernelStore.getObjectRefCount(kref)).toStrictEqual({
      reachable: 0,
      recognizable: 0,
    });
  });

  it('takes delivery of deliver retireImports', async () => {
    const remote = makeRemote();

    // An object, as if it had been imported from the other end (and thus exported here)
    const roref = 'ro+1';
    const koref = mockKernelStore.translateRefEtoK(remote.remoteId, roref);

    // As if we're no longer using it (which, in fact, we weren't), which is a
    // prequisite for a valid 'retireImports' delivery
    mockKernelStore.clearReachableFlag(remote.remoteId, koref);

    // Now have the "other end" retire the import (include seq for incoming message)
    const retireImports = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['retireImports', [roref]],
    });
    await receiveAndRunCrank(remote, retireImports);

    // Object should have disappeared from the clists
    expect(() =>
      mockKernelStore.translateRefKtoE(remote.remoteId, koref, false),
    ).toThrow(`unmapped kref "${koref}" endpoint="${remote.remoteId}"`);
    expect(mockKernelStore.erefToKref(remote.remoteId, roref)).toBeUndefined();
  });

  it('takes delivery of bogus deliver', async () => {
    const remote = makeRemote();
    // Include seq for incoming message
    const delivery = JSON.stringify({
      seq: 1,
      method: 'deliver',
      params: ['bogus'],
    });
    await expect(remote.deliverInbound(delivery)).rejects.toThrow(
      'unknown remote delivery method bogus',
    );
  });

  it('takes delivery of redeemURL request', async () => {
    const remote = makeRemote();
    const mockOcapURL = 'as if it was a URL';
    const mockReplyKey = 'replyKey';
    // A URL only ever names an object the kernel still has, so redeem one that
    // exists: importing a deleted kref is refused outright.
    const replyKRef = mockKernelStore.initKernelObject('kernel');
    vi.spyOn(mockRemoteComms, 'redeemLocalOcapURL').mockResolvedValue(
      replyKRef,
    );
    const replyRRef = 'ro+1';
    // Include seq for incoming message
    const request = JSON.stringify({
      seq: 1,
      method: 'redeemURL',
      params: [mockOcapURL, mockReplyKey],
    });
    mockKernelStore.initEndpoint(remote.remoteId); // mock effects of stuff that was never called
    await receiveAndRunCrank(remote, request);
    expect(mockRemoteComms.redeemLocalOcapURL).toHaveBeenCalledWith(
      mockOcapURL,
    );
    // Verify reply was sent with seq/ack via sendRemoteMessage
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalled();
    const sentMessage = JSON.parse(
      mockRemoteComms.sendRemoteMessage.mock.calls[0]?.[1] ?? '{}',
    );
    expect(sentMessage.method).toBe('redeemURLReply');
    expect(sentMessage.params).toStrictEqual([true, mockReplyKey, replyRRef]);
    expect(sentMessage.seq).toBe(1); // First outgoing message gets seq 1
    // Reply is sent after commit, so ACK can be piggybacked
    expect(sentMessage.ack).toBe(1);
    expect(
      mockKernelStore.translateRefKtoE(remote.remoteId, replyKRef, false),
    ).toBe(replyRRef);
  });

  it('takes delivery of redeemURL request with error', async () => {
    const remote = makeRemote();
    const mockOcapURL = 'invalid-url';
    const mockReplyKey = 'replyKey';
    const errorMessage = 'Invalid URL format';

    // Mock redeemLocalOcapURL to throw an error
    vi.spyOn(mockRemoteComms, 'redeemLocalOcapURL').mockRejectedValue(
      new Error(errorMessage),
    );

    // Include seq for incoming message
    const request = JSON.stringify({
      seq: 1,
      method: 'redeemURL',
      params: [mockOcapURL, mockReplyKey],
    });

    await receiveAndRunCrank(remote, request);

    expect(mockRemoteComms.redeemLocalOcapURL).toHaveBeenCalledWith(
      mockOcapURL,
    );
    // Verify error reply was sent with seq/ack via sendRemoteMessage
    expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalled();
    const sentMessage = JSON.parse(
      mockRemoteComms.sendRemoteMessage.mock.calls[0]?.[1] ?? '{}',
    );
    expect(sentMessage.method).toBe('redeemURLReply');
    expect(sentMessage.params).toStrictEqual([
      false,
      mockReplyKey,
      errorMessage,
    ]);
    expect(sentMessage.seq).toBe(1); // First outgoing message gets seq 1
    // Reply is sent after commit, so ACK can be piggybacked
    expect(sentMessage.ack).toBe(1);
  });

  it('handleRemoteMessage rejects bogus message type', async () => {
    const remote = makeRemote();
    // Include seq for incoming message
    const request = JSON.stringify({
      seq: 1,
      method: 'bogus',
      params: [],
    });
    await expect(remote.deliverInbound(request)).rejects.toThrow(
      'unknown remote message type bogus',
    );
  });

  it('rejectPendingRedemptions rejects all pending redemptions', async () => {
    const remote = makeRemote();
    const errorMessage = 'Connection lost';

    // Start multiple URL redemptions
    const promise1 = remote.redeemOcapURL('url1');
    const promise2 = remote.redeemOcapURL('url2');
    const promise3 = remote.redeemOcapURL('url3');

    // Reject all pending redemptions
    remote.rejectPendingRedemptions(errorMessage);

    // All promises should be rejected with the error
    await expect(promise1).rejects.toThrow(errorMessage);
    await expect(promise2).rejects.toThrow(errorMessage);
    await expect(promise3).rejects.toThrow(errorMessage);
  });

  it('rejectPendingRedemptions clears pending redemptions map', async () => {
    const remote = makeRemote();
    const errorMessage = 'Connection lost';

    // Start a URL redemption
    const promise = remote.redeemOcapURL('url1');

    // Reject all pending redemptions
    remote.rejectPendingRedemptions(errorMessage);

    // Try to handle a reply for the rejected redemption - should fail (include seq)
    const redeemURLReply = {
      seq: 1,
      method: 'redeemURLReply',
      params: [true, '1', 'ro+1'],
    };
    await expect(
      remote.deliverInbound(JSON.stringify(redeemURLReply)),
    ).rejects.toThrow('unknown URL redemption reply key 1');

    await expect(promise).rejects.toThrow(errorMessage);
  });

  it('rejectPendingRedemptions handles empty pending redemptions', () => {
    const remote = makeRemote();
    const errorMessage = 'Connection lost';

    // Should not throw when there are no pending redemptions
    expect(() => remote.rejectPendingRedemptions(errorMessage)).not.toThrow();
  });

  it('giveUp rejects pending messages and redemptions', async () => {
    const remote = makeRemote();
    const reason = 'transport gave up';

    // Send a message to create pending state
    const resolutions: VatOneResolution[] = [
      ['rp+3', false, { body: '"value"', slots: [] }],
    ];
    await deliverAndCommit(remote.deliverNotify(resolutions));

    // Start a URL redemption
    const redeemPromise = remote.redeemOcapURL('ocap:test@peer');

    remote.giveUp(reason);

    // Pending redemption was rejected
    await expect(redeemPromise).rejects.toThrow(reason);

    // Pending messages were discarded (startSeq advanced past all pending).
    // deliverNotify used seq 1, redeemOcapURL used seq 2, so nextSendSeq = 2
    // and startSeq is set to nextSendSeq + 1 = 3.
    const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
    expect(seqState?.startSeq).toBe(3);
  });

  it('redeemOcapURL increments redemption counter for multiple redemptions', async () => {
    const remote = makeRemote();
    const mockOcapURL1 = 'url1';
    const mockOcapURL2 = 'url2';
    const mockOcapURL3 = 'url3';

    // Start multiple redemptions
    const promise1 = remote.redeemOcapURL(mockOcapURL1);
    const promise2 = remote.redeemOcapURL(mockOcapURL2);
    const promise3 = remote.redeemOcapURL(mockOcapURL3);

    // Resolve all redemptions (include seq for incoming messages)
    await receiveAndRunCrank(
      remote,
      JSON.stringify({
        seq: 1,
        method: 'redeemURLReply',
        params: [true, '1', 'ro+1'],
      }),
    );
    await receiveAndRunCrank(
      remote,
      JSON.stringify({
        seq: 2,
        method: 'redeemURLReply',
        params: [true, '2', 'ro+2'],
      }),
    );
    await receiveAndRunCrank(
      remote,
      JSON.stringify({
        seq: 3,
        method: 'redeemURLReply',
        params: [true, '3', 'ro+3'],
      }),
    );

    await promise1;
    await promise2;
    await promise3;

    // Verify each redemption uses a different reply key (messages are strings with seq)
    const { calls } = vi.mocked(mockRemoteComms.sendRemoteMessage).mock;
    const parsedMessages = calls.map((call) => JSON.parse(call[1]));

    expect(parsedMessages[0].method).toBe('redeemURL');
    expect(parsedMessages[0].params).toStrictEqual([mockOcapURL1, '1']);
    expect(parsedMessages[1].method).toBe('redeemURL');
    expect(parsedMessages[1].params).toStrictEqual([mockOcapURL2, '2']);
    expect(parsedMessages[2].method).toBe('redeemURL');
    expect(parsedMessages[2].params).toStrictEqual([mockOcapURL3, '3']);
  });

  it('handles multiple concurrent URL redemptions independently', async () => {
    const remote = makeRemote();
    const mockOcapURL1 = 'url1';
    const mockOcapURL2 = 'url2';
    const mockURLResolutionRRef1 = 'ro+1';
    const mockURLResolutionRRef2 = 'ro+2';

    // Start two concurrent redemptions
    const promise1 = remote.redeemOcapURL(mockOcapURL1);
    const promise2 = remote.redeemOcapURL(mockOcapURL2);

    // Resolve them in reverse order to verify they're handled independently (include seq)
    await receiveAndRunCrank(
      remote,
      JSON.stringify({
        seq: 1,
        method: 'redeemURLReply',
        params: [true, '2', mockURLResolutionRRef2],
      }),
    );
    await receiveAndRunCrank(
      remote,
      JSON.stringify({
        seq: 2,
        method: 'redeemURLReply',
        params: [true, '1', mockURLResolutionRRef1],
      }),
    );

    const kref1 = await promise1;
    const kref2 = await promise2;

    // Verify each promise resolved with the correct value based on its reply key
    expect(kref1).toBe(
      mockKernelStore.translateRefEtoK(remote.remoteId, mockURLResolutionRRef1),
    );
    expect(kref2).toBe(
      mockKernelStore.translateRefEtoK(remote.remoteId, mockURLResolutionRRef2),
    );
    // Verify they resolved independently (different values)
    expect(kref1).not.toBe(kref2);
  });

  describe('redeemOcapURL timeout', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('sets up redemption timeout derived from ACK timeout and max retries', async () => {
      const remote = makeRemote();
      const mockOcapURL = 'ocap:test@peer';

      let mockSignal: ReturnType<typeof makeAbortSignalMock> | undefined;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        mockSignal = makeAbortSignalMock(ms);
        return mockSignal;
      });

      const urlPromise = remote.redeemOcapURL(mockOcapURL);

      // Default: ACK_TIMEOUT_MS (10_000) * (MAX_RETRIES (3) + 1) = 40_000
      expect(AbortSignal.timeout).toHaveBeenCalledWith(40_000);
      expect(mockSignal?.timeoutMs).toBe(40_000);

      // Wait for sendRemoteMessage to be called
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Resolve the redemption to avoid hanging (parse string to get reply key)
      const sendCall = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0];
      const sentMessage = JSON.parse(sendCall![1]);
      const replyKey = sentMessage.params[1] as string;

      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          method: 'redeemURLReply',
          params: [true, replyKey, 'ro+1'],
        }),
      );

      await urlPromise;
    });

    it('cleans up pending redemption when redemption succeeds before timeout', async () => {
      const remote = makeRemote();
      const mockOcapURL = 'ocap:test@peer';
      const mockURLResolutionRRef = 'ro+6';
      const mockURLResolutionKRef = 'ko1';
      const expectedReplyKey = '1';

      let mockSignal: ReturnType<typeof makeAbortSignalMock> | undefined;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        mockSignal = makeAbortSignalMock(ms);
        return mockSignal;
      });

      const urlPromise = remote.redeemOcapURL(mockOcapURL);

      // Send reply immediately (before timeout) - include seq
      const redeemURLReply = {
        seq: 1,
        method: 'redeemURLReply',
        params: [true, expectedReplyKey, mockURLResolutionRRef],
      };
      await receiveAndRunCrank(remote, JSON.stringify(redeemURLReply));

      const kref = await urlPromise;
      expect(kref).toBe(mockURLResolutionKRef);

      // Verify timeout signal was not aborted
      expect(mockSignal?.aborted).toBe(false);

      // Verify cleanup happened - trying to handle another reply with the same key should fail
      // Use different seq for the duplicate attempt
      const duplicateReply = { ...redeemURLReply, seq: 2 };
      await expect(
        remote.deliverInbound(JSON.stringify(duplicateReply)),
      ).rejects.toThrow(`unknown URL redemption reply key ${expectedReplyKey}`);
    });

    it('cleans up pending redemption map entry on timeout', async () => {
      const remote = makeRemote();
      const mockOcapURL = 'ocap:test@peer';

      let mockSignal: ReturnType<typeof makeAbortSignalMock> | undefined;
      vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms: number) => {
        mockSignal = makeAbortSignalMock(ms);
        return mockSignal;
      });

      // Start a redemption
      const urlPromise = remote.redeemOcapURL(mockOcapURL);

      // Wait for sendRemoteMessage to be called
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Get the reply key that was used (parse string)
      const sendCall = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0];
      const sentMessage = JSON.parse(sendCall![1]);
      const replyKey = sentMessage.params[1] as string;

      // Wait for the promise to be set up and event listener registered
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Manually trigger the abort to simulate timeout
      mockSignal?.abort();

      // Wait for the abort handler to execute
      await new Promise<void>((resolve) => queueMicrotask(() => resolve()));

      // Verify the promise rejects with dynamic timeout message
      await expect(urlPromise).rejects.toThrow(
        'URL redemption timed out after 40000ms',
      );

      // Verify cleanup happened - trying to handle a reply with the same key should fail
      // Include seq for incoming message
      const redeemURLReply = {
        seq: 1,
        method: 'redeemURLReply',
        params: [true, replyKey, 'ro+1'],
      };
      await expect(
        remote.deliverInbound(JSON.stringify(redeemURLReply)),
      ).rejects.toThrow(`unknown URL redemption reply key ${replyKey}`);
    });
  });

  describe('message acknowledgment protocol', () => {
    it('tracks highest received sequence number', async () => {
      const remote = makeRemote();

      // Test data - use notify which is simpler than message delivery
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Receive a message with seq=5
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 5,
          method: 'deliver',
          params: ['notify', resolutions],
        }),
      );

      // Now send a message - it should include ack=5 (piggyback ACK)
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]![1];
      const parsed = JSON.parse(sentString);
      expect(parsed.ack).toBe(5);
    });

    it('includes ack field on outgoing messages when we have received messages', async () => {
      const remote = makeRemote();

      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // First message sent should not have ack (nothing received yet)
      await deliverAndCommit(remote.deliverNotify(resolutions));

      let sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]![1];
      let parsed = JSON.parse(sentString);
      expect(parsed.ack).toBeUndefined();
      expect(parsed.seq).toBe(1);

      // Receive a message
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          method: 'deliver',
          params: ['notify', resolutions],
        }),
      );

      // Now send another message - it should include piggyback ack
      await deliverAndCommit(remote.deliverNotify(resolutions));

      sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[1]![1];
      parsed = JSON.parse(sentString);
      expect(parsed.ack).toBe(1);
      expect(parsed.seq).toBe(2);
    });

    it('processes message after handling seq/ack', async () => {
      const remote = makeRemote();

      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Incoming delivery message with seq/ack
      const deliveryMessage = {
        seq: 10,
        ack: 8,
        method: 'deliver',
        params: ['notify', resolutions],
      };

      await receiveAndRunCrank(remote, JSON.stringify(deliveryMessage));

      // Verify kernel queue was called
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalled();
    });

    it('handles standalone ACK messages (ack only, no seq)', async () => {
      const remote = makeRemote();

      // Receive a standalone ACK - this happens when the remote has nothing to send
      // but wants to acknowledge our messages
      const standaloneAck = JSON.stringify({ ack: 5 });

      await receiveAndRunCrank(remote, standaloneAck);

      // An acknowledgement is not a delivery: it is handled where it arrives
      // and never reaches the run queue.
      expect(mockKernelQueue.acceptRemoteInbound).not.toHaveBeenCalled();
    });

    it('assigns sequential sequence numbers to outgoing messages', async () => {
      const remote = makeRemote();

      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Send three messages
      await deliverAndCommit(remote.deliverNotify(resolutions));
      await deliverAndCommit(remote.deliverNotify(resolutions));
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const { calls } = vi.mocked(mockRemoteComms.sendRemoteMessage).mock;
      expect(JSON.parse(calls[0]![1]).seq).toBe(1);
      expect(JSON.parse(calls[1]![1]).seq).toBe(2);
      expect(JSON.parse(calls[2]![1]).seq).toBe(3);
    });
  });

  describe('the front half, at receive time', () => {
    // A queue item that throws on delivery kills the run loop, and the
    // rollback puts it back to kill the next boot too. So a message that
    // cannot be delivered must be refused before it becomes one.
    it.each([
      { what: 'no seq', message: { method: 'deliver', params: [] } },
      { what: 'a non-numeric seq', message: { seq: 'bogus', method: 'x' } },
      { what: 'a fractional seq', message: { seq: 1.5, method: 'x' } },
      { what: 'a seq below one', message: { seq: 0, method: 'x' } },
    ])('refuses $what without queueing anything', ({ message }) => {
      const remote = makeRemote();

      expect(() => remote.receiveFromPeer(JSON.stringify(message))).toThrow(
        'invalid message seq',
      );

      expect(mockKernelQueue.acceptRemoteInbound).not.toHaveBeenCalled();
      // Left to be written, `highestReceivedSeq` reads back as `NaN`, and
      // every later comparison against it is false: duplicate detection never
      // fires again and the peer is never acknowledged again.
      expect(
        mockKernelStore.getRemoteSeqState(mockRemoteId)?.highestReceivedSeq,
      ).not.toBe(Number.NaN);
    });

    it('acknowledges a retransmission the crank will discard as a duplicate', async () => {
      let sendAck: (() => void) | undefined;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
      ) => {
        sendAck = callback;
        return 1 as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      const remote = makeRemote();
      const message = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', []],
      });
      await receiveAndRunCrank(remote, message);
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockClear();
      sendAck = undefined;

      // The peer retransmits, which is it telling us it never got our
      // acknowledgement. Arming the timer only for messages the crank accepts
      // would leave it retransmitting to silence until it tore the link down.
      await receiveAndRunCrank(remote, message);
      sendAck?.();

      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledOnce();
    });

    it('takes the acknowledgement off a message it queues', async () => {
      const remote = makeRemote();
      await deliverAndCommit(remote.deliverNotify([]));
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 1)).toBeDefined();

      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          ack: 1,
          method: 'deliver',
          params: ['notify', []],
        }),
      );

      // A piggybacked ack dropped here leaves the kernel retransmitting a
      // message the peer has already taken.
      expect(
        mockKernelStore.getPendingMessage(mockRemoteId, 1),
      ).toBeUndefined();
    });
  });

  describe('two messages from one peer in flight at once', () => {
    // The run queue can hold several before any of their cranks commit, and
    // `#highestReceivedSeq` only catches up as each one does — so memory is
    // the wrong thing to compare against.
    it('tells them apart by what the store has, not what memory has', async () => {
      const remote = makeRemote();
      const message = (seq: number): string =>
        JSON.stringify({ seq, method: 'deliver', params: ['notify', []] });

      // Two cranks, neither of their post-commit halves run yet.
      const first = await remote.deliverInbound(message(1));
      const second = await remote.deliverInbound(message(2));
      await first.afterCommit?.();
      await second.afterCommit?.();

      expect(
        mockKernelStore.getRemoteSeqState(mockRemoteId)?.highestReceivedSeq,
      ).toBe(2);
    });

    it('discards the second delivery of one sequence number', async () => {
      const remote = makeRemote();
      const message = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', [['rp+1', false, { body: '"x"', slots: [] }]]],
      });
      await remote.deliverInbound(message);
      vi.mocked(mockKernelQueue.resolvePromises).mockClear();

      // Its crank has not committed, so memory still says nothing was received.
      const result = await remote.deliverInbound(message);

      expect(result.afterCommit).toBeUndefined();
      expect(mockKernelQueue.resolvePromises).not.toHaveBeenCalled();
    });
  });

  describe('message persistence', () => {
    it('persists pending messages to storage on send', async () => {
      const remote = makeRemote();
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      await deliverAndCommit(remote.deliverNotify(resolutions));

      // Verify message was persisted (as a plain string)
      const pendingMsgString = mockKernelStore.getPendingMessage(
        mockRemoteId,
        1,
      );
      expect(pendingMsgString).toBeDefined();
      expect(pendingMsgString).toContain('"seq":1');

      // Verify seq state was persisted
      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState).toStrictEqual({
        nextSendSeq: 1,
        highestReceivedSeq: 0,
        startSeq: 1,
      });
    });

    it('persists highestReceivedSeq when receiving messages', async () => {
      const remote = makeRemote();
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Receive a message with seq=5
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 5,
          method: 'deliver',
          params: ['notify', resolutions],
        }),
      );

      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState?.highestReceivedSeq).toBe(5);
    });

    it('deletes persisted messages when ACKed', async () => {
      const remote = makeRemote();
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Send two messages
      await deliverAndCommit(remote.deliverNotify(resolutions));
      await deliverAndCommit(remote.deliverNotify(resolutions));

      // Verify both are persisted
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 1)).toBeDefined();
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 2)).toBeDefined();

      // ACK the first message
      await receiveAndRunCrank(remote, JSON.stringify({ ack: 1 }));

      // First message should be deleted, second should remain
      expect(
        mockKernelStore.getPendingMessage(mockRemoteId, 1),
      ).toBeUndefined();
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 2)).toBeDefined();

      // startSeq should be updated
      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState?.startSeq).toBe(2);
    });

    it('restores pending messages on startup', async () => {
      // Pre-populate storage with persisted state (messages stored as plain strings)
      mockKernelStore.setRemoteNextSendSeq(mockRemoteId, 3);
      mockKernelStore.setRemoteHighestReceivedSeq(mockRemoteId, 2);
      mockKernelStore.setRemoteStartSeq(mockRemoteId, 2);
      mockKernelStore.setPendingMessage(mockRemoteId, 2, 'message 2');
      mockKernelStore.setPendingMessage(mockRemoteId, 3, 'message 3');

      // Create a new RemoteHandle - should restore state
      const remote = makeRemote();

      // Send another message - should get seq 4
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // Verify restore happened by checking the next seq number assigned
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]?.[1];
      expect(sentString).toBeDefined();
      const parsed = JSON.parse(sentString as string);
      expect(parsed.seq).toBe(4);
      expect(parsed.ack).toBe(2); // Should have restored highestReceivedSeq
    });

    it('repairs nextSendSeq from scanned messages on crash recovery', async () => {
      // Simulate crash during enqueue: message written but nextSendSeq not updated
      mockKernelStore.setRemoteNextSendSeq(mockRemoteId, 2);
      mockKernelStore.setRemoteStartSeq(mockRemoteId, 1);
      // But messages 1, 2, and 3 exist (3 was written but seq not incremented)
      mockKernelStore.setPendingMessage(mockRemoteId, 1, 'message 1');
      mockKernelStore.setPendingMessage(mockRemoteId, 2, 'message 2');
      mockKernelStore.setPendingMessage(mockRemoteId, 3, 'message 3');

      // Create RemoteHandle - should detect and repair
      const remote = makeRemote();

      // Next message should get seq 4 (repaired from scanning)
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]?.[1];
      expect(sentString).toBeDefined();
      const parsed = JSON.parse(sentString as string);
      expect(parsed.seq).toBe(4);

      // Verify nextSendSeq was repaired in storage
      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState?.nextSendSeq).toBe(4); // Updated after the new send
    });

    it('repairs missing startSeq on crash recovery for first message', async () => {
      // Simulate crash during first enqueue: message and startSeq written, but
      // nextSendSeq not updated. This tests the crash-safe write ordering where
      // startSeq is persisted before nextSendSeq.
      mockKernelStore.setRemoteStartSeq(mockRemoteId, 1);
      // nextSendSeq not written (defaults to 0)
      mockKernelStore.setPendingMessage(mockRemoteId, 1, 'message 1');

      // Create RemoteHandle - should detect message at nextSendSeq+1 and repair
      const remote = makeRemote();

      // Next message should get seq 2 (repaired nextSendSeq from 0 to 1, then +1)
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]?.[1];
      expect(sentString).toBeDefined();
      const parsed = JSON.parse(sentString as string);
      expect(parsed.seq).toBe(2);

      // Verify state is correct: 2 pending messages (seq 1 and 2)
      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState?.startSeq).toBe(1);
      expect(seqState?.nextSendSeq).toBe(2);
    });

    it('recovers orphan message when no seq state exists', async () => {
      // Simulate crash during first enqueue: message written but NO seq state
      // persisted at all. This can happen if crash occurs after setPendingMessage
      // but before setRemoteStartSeq.
      mockKernelStore.setPendingMessage(mockRemoteId, 1, 'message 1');
      // No seq state set - getRemoteSeqState will return undefined

      // Create RemoteHandle - should scan and find orphan message at seq 1
      const remote = makeRemote();

      // Next message should get seq 2 (recovered seq 1, then +1)
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]?.[1];
      expect(sentString).toBeDefined();
      const parsed = JSON.parse(sentString as string);
      expect(parsed.seq).toBe(2);

      // Verify state is correct: seq state recovered and 2 pending messages
      const seqState = mockKernelStore.getRemoteSeqState(mockRemoteId);
      expect(seqState?.startSeq).toBe(1);
      expect(seqState?.nextSendSeq).toBe(2);
      // Original orphan message still exists
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 1)).toBe(
        'message 1',
      );
    });

    it('cleans up orphan messages (seq < startSeq) on recovery', () => {
      // Simulate crash during ACK: startSeq updated but message not deleted
      mockKernelStore.setRemoteNextSendSeq(mockRemoteId, 3);
      mockKernelStore.setRemoteStartSeq(mockRemoteId, 2);
      // Orphan message at seq 1 (already acked per startSeq=2)
      mockKernelStore.setPendingMessage(mockRemoteId, 1, 'message 1');
      // Valid pending at seq 2 and 3
      mockKernelStore.setPendingMessage(mockRemoteId, 2, 'message 2');
      mockKernelStore.setPendingMessage(mockRemoteId, 3, 'message 3');

      // Create RemoteHandle - should clean up orphan during recovery
      makeRemote();

      // Orphan should be deleted
      expect(
        mockKernelStore.getPendingMessage(mockRemoteId, 1),
      ).toBeUndefined();
      // Valid pending messages should remain
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 2)).toBeDefined();
      expect(mockKernelStore.getPendingMessage(mockRemoteId, 3)).toBeDefined();
    });

    it('handles fresh remote with no persisted state', async () => {
      // No pre-populated storage - should start fresh
      const remote = makeRemote();

      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]?.[1];
      expect(sentString).toBeDefined();
      const parsed = JSON.parse(sentString as string);
      expect(parsed.seq).toBe(1); // Fresh start
      expect(parsed.ack).toBeUndefined(); // No highestReceivedSeq
    });

    it('ignores duplicate messages (seq <= highestReceivedSeq)', async () => {
      const remote = makeRemote();
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      // First message with seq=1 - should process
      const message1 = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', resolutions],
      });
      await receiveAndRunCrank(remote, message1);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledTimes(1);

      // Duplicate message with seq=1 - should ignore
      const message2 = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', resolutions],
      });
      await receiveAndRunCrank(remote, message2);
      // Should still be 1 call, not 2
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledTimes(1);

      // Message with seq=2 - should process
      const message3 = JSON.stringify({
        seq: 2,
        method: 'deliver',
        params: ['notify', resolutions],
      });
      await receiveAndRunCrank(remote, message3);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledTimes(2);
    });

    it('persists highestReceivedSeq atomically with message processing', async () => {
      const remote = makeRemote();
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];

      const message = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', resolutions],
      });

      await receiveAndRunCrank(remote, message);

      // Verify highestReceivedSeq was persisted
      expect(
        mockKernelStore.getRemoteSeqState(mockRemoteId)?.highestReceivedSeq,
      ).toBe(1);
    });

    it('restores highestReceivedSeq on processing error', async () => {
      const remote = makeRemote();

      // First, process a valid message to set highestReceivedSeq to 1
      const validMessage = JSON.stringify({
        seq: 1,
        method: 'deliver',
        params: ['notify', [['rp+3', false, { body: '"value"', slots: [] }]]],
      });
      await receiveAndRunCrank(remote, validMessage);
      expect(
        mockKernelStore.getRemoteSeqState(mockRemoteId)?.highestReceivedSeq,
      ).toBe(1);

      // Now send a message that will cause an error
      const badMessage = JSON.stringify({
        seq: 2,
        method: 'deliver',
        params: ['bogus'], // Unknown delivery method
      });

      await expect(remote.deliverInbound(badMessage)).rejects.toThrow(
        'unknown remote delivery method bogus',
      );

      // highestReceivedSeq should still be 1 (restored after rollback)
      // Send another message with seq=2 to verify it's not considered a duplicate
      vi.mocked(mockKernelQueue.resolvePromises).mockClear();
      const retryMessage = JSON.stringify({
        seq: 2,
        method: 'deliver',
        params: ['notify', [['rp+4', false, { body: '"value2"', slots: [] }]]],
      });
      await receiveAndRunCrank(remote, retryMessage);
      expect(mockKernelQueue.resolvePromises).toHaveBeenCalledTimes(1);
    });
  });

  describe('handlePeerRestart', () => {
    it('resets sequence numbers for fresh start', async () => {
      const remote = makeRemote();

      // Build up some state by sending and receiving messages
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 5,
          method: 'deliver',
          params: ['notify', resolutions],
        }),
      );

      // Call handlePeerRestart
      remote.handlePeerRestart();

      // Send a new message - should start from seq=1
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockClear();
      await deliverAndCommit(remote.deliverNotify(resolutions));

      const sentString = vi.mocked(mockRemoteComms.sendRemoteMessage).mock
        .calls[0]![1];
      const parsed = JSON.parse(sentString);
      expect(parsed.seq).toBe(1);
      // ack should not be included since highestReceivedSeq was reset to 0
      expect(parsed.ack).toBeUndefined();
    });

    it('clears persisted sequence state', async () => {
      const remote = makeRemote();

      // Build up state
      const promiseRRef = 'rp+3';
      const resolutions: VatOneResolution[] = [
        [promiseRRef, false, { body: '"resolved value"', slots: [] }],
      ];
      await deliverAndCommit(remote.deliverNotify(resolutions));

      // Verify state exists before restart
      expect(mockKernelStore.getRemoteSeqState(mockRemoteId)).toBeDefined();

      // Call handlePeerRestart
      remote.handlePeerRestart();

      // Verify state was cleared
      expect(mockKernelStore.getRemoteSeqState(mockRemoteId)).toBeUndefined();
    });

    it('rejects pending URL redemptions', async () => {
      const remote = makeRemote();

      // Start a redemption but don't resolve it
      const redeemPromise = remote.redeemOcapURL('ocap:test@peer,relay');

      // Call handlePeerRestart
      remote.handlePeerRestart();

      // The pending redemption should be rejected
      await expect(redeemPromise).rejects.toThrow('Remote peer restarted');
    });

    it('resets remoteGcRequested flag so BOYD is sent to new incarnation', async () => {
      const remote = makeRemote();

      // Receive BOYD from remote — sets the ping-pong prevention flag
      await receiveAndRunCrank(
        remote,
        JSON.stringify({
          seq: 1,
          method: 'deliver',
          params: ['bringOutYourDead'],
        }),
      );

      // Peer restarts — flag should be cleared
      remote.handlePeerRestart();

      // Next deliverBringOutYourDead should send BOYD (not suppress it)
      await deliverAndCommit(remote.deliverBringOutYourDead());
      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledWith(
        mockRemotePeerId,
        expect.any(String),
      );
    });
  });

  describe('ack timeout retransmit', () => {
    // SES lockdown freezes Date, preventing vi.useFakeTimers(); spy on
    // setTimeout instead and invoke captured callbacks directly.
    type PendingTimer = {
      callback: () => void;
      delay: number;
    };
    let pendingTimers: PendingTimer[];
    let setTimeoutSpy: ReturnType<typeof vi.spyOn>;
    let clearTimeoutSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      pendingTimers = [];
      setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
        callback: () => void,
        delay: number,
      ) => {
        pendingTimers.push({ callback, delay });
        return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
      }) as typeof setTimeout);
      clearTimeoutSpy = vi
        .spyOn(globalThis, 'clearTimeout')
        .mockImplementation((handle: unknown) => {
          if (typeof handle === 'number') {
            pendingTimers[handle - 1] = {
              callback: () => undefined,
              delay: 0,
            };
          }
        });
    });

    afterEach(() => {
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    });

    /**
     * Trigger the most recent ACK timer (skipping any cleared/no-op slots).
     */
    function fireLastAckTimer(): void {
      for (let i = pendingTimers.length - 1; i >= 0; i -= 1) {
        const timer = pendingTimers[i];
        if (timer && timer.delay > 0) {
          timer.callback();
          return;
        }
      }
    }

    it('sends pending messages sequentially, awaiting each before the next', async () => {
      const remote = RemoteHandle.make({
        remoteId: mockRemoteId,
        peerId: mockRemotePeerId,
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        remoteComms: mockRemoteComms,
        ackTimeoutMs: 100,
      });

      await deliverAndCommit(
        remote.deliverNotify([['rp+1', false, { body: '"first"', slots: [] }]]),
      );
      await deliverAndCommit(
        remote.deliverNotify([
          ['rp+2', false, { body: '"second"', slots: [] }],
        ]),
      );

      // send 1 stays pending until we resolve it.
      const sendCalls: string[] = [];
      let resolveFirst!: () => void;
      const firstPromise = new Promise<void>((resolve) => {
        resolveFirst = resolve;
      });
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockReset();
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockImplementation(
        async (_peer, payload) => {
          sendCalls.push(payload);
          if (sendCalls.length === 1) {
            await firstPromise;
          }
          return undefined;
        },
      );

      fireLastAckTimer();
      // Yield to microtasks so the first iteration's await sees the pending
      // promise but hasn't yet moved on.
      await Promise.resolve();
      await Promise.resolve();
      expect(sendCalls).toHaveLength(1);

      resolveFirst();
      // Drain microtasks so the second iteration completes.
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }
      expect(sendCalls).toHaveLength(2);
    });

    it('aborts retransmit and fires give-up when sendRemoteMessage signals peer restart', async () => {
      const onGiveUp = vi.fn();
      const remote = RemoteHandle.make({
        remoteId: mockRemoteId,
        peerId: mockRemotePeerId,
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        remoteComms: mockRemoteComms,
        ackTimeoutMs: 100,
        onGiveUp,
      });

      await deliverAndCommit(
        remote.deliverNotify([['rp+1', false, { body: '"a"', slots: [] }]]),
      );
      await deliverAndCommit(
        remote.deliverNotify([['rp+2', false, { body: '"b"', slots: [] }]]),
      );

      // Synthesize a PeerRestartedError-shaped rejection (the real class is
      // transport-internal; isTerminalSendError matches by `error.name`).
      const peerRestarted = Object.assign(
        new Error('Remote peer restarted: message not sent'),
        { name: 'PeerRestartedError' },
      );
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockReset();
      vi.mocked(mockRemoteComms.sendRemoteMessage).mockRejectedValue(
        peerRestarted,
      );

      fireLastAckTimer();
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      // Only iteration 1 runs before the terminal error short-circuits.
      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledTimes(1);
      expect(onGiveUp).toHaveBeenCalledWith(mockRemotePeerId);
    });

    it('logs and continues on transient send errors', async () => {
      const onGiveUp = vi.fn();
      const remote = RemoteHandle.make({
        remoteId: mockRemoteId,
        peerId: mockRemotePeerId,
        kernelStore: mockKernelStore,
        kernelQueue: mockKernelQueue,
        remoteComms: mockRemoteComms,
        ackTimeoutMs: 100,
        onGiveUp,
      });

      await deliverAndCommit(
        remote.deliverNotify([['rp+1', false, { body: '"a"', slots: [] }]]),
      );
      await deliverAndCommit(
        remote.deliverNotify([['rp+2', false, { body: '"b"', slots: [] }]]),
      );

      vi.mocked(mockRemoteComms.sendRemoteMessage).mockReset();
      vi.mocked(mockRemoteComms.sendRemoteMessage)
        .mockRejectedValueOnce(new Error('temporary network glitch'))
        .mockResolvedValueOnce(undefined);

      fireLastAckTimer();
      for (let i = 0; i < 5; i += 1) {
        await Promise.resolve();
      }

      // Both iterations ran — the transient failure didn't abort.
      expect(mockRemoteComms.sendRemoteMessage).toHaveBeenCalledTimes(2);
      expect(onGiveUp).not.toHaveBeenCalled();
    });
  });

  describe('first-send terminal errors', () => {
    it.each([
      [
        'PeerRestartedError',
        Object.assign(new Error('peer restarted'), {
          name: 'PeerRestartedError',
        }),
      ],
      [
        'IntentionalCloseError',
        Object.assign(new Error('intentional close'), {
          name: 'IntentionalCloseError',
        }),
      ],
      [
        'NetworkStoppedError',
        Object.assign(new Error('Network stopped'), {
          name: 'NetworkStoppedError',
        }),
      ],
    ])(
      'rejects pending and fires onGiveUp when initial send rejects with %s',
      async (_name, terminalError) => {
        const onGiveUp = vi.fn();
        const remote = RemoteHandle.make({
          remoteId: mockRemoteId,
          peerId: mockRemotePeerId,
          kernelStore: mockKernelStore,
          kernelQueue: mockKernelQueue,
          remoteComms: mockRemoteComms,
          ackTimeoutMs: 100,
          onGiveUp,
        });

        vi.mocked(mockRemoteComms.sendRemoteMessage).mockRejectedValueOnce(
          terminalError,
        );

        const redeem = remote.redeemOcapURL('ocap:something@peer,relay');
        // Drain microtasks so the catch handler runs.
        for (let i = 0; i < 5; i += 1) {
          await Promise.resolve();
        }

        // The redemption rejects with the giveUp/rejectAllPending reason,
        // which is the terminal error's message string.
        await expect(redeem).rejects.toThrow(terminalError.message);
        expect(onGiveUp).toHaveBeenCalledWith(mockRemotePeerId);
      },
    );
  });

  describe('handlePeerRestart c-list teardown', () => {
    it('clears the peer’s "+"-direction c-list entries via forgetEndpointImports', async () => {
      const remote = makeRemote();

      // Seed an object export from the peer (peer-allocated eref ro+5
      // mapped to a fresh kernel object).
      const eref = 'ro+5';
      const kref = mockKernelStore.exportFromEndpoint(mockRemoteId, eref);

      // Sanity: c-list is populated in both directions before restart.
      // Use the raw `krefToEref`/`erefToKref` lookups (not the translating
      // wrappers, which flip RRef polarity for receiver-frame interpretation).
      expect(mockKernelStore.erefToKref(mockRemoteId, eref)).toBe(kref);
      expect(mockKernelStore.krefToEref(mockRemoteId, kref)).toBe(eref);

      remote.handlePeerRestart();

      // Both halves of the c-list pair are gone after restart.
      expect(mockKernelStore.erefToKref(mockRemoteId, eref)).toBeUndefined();
      expect(mockKernelStore.krefToEref(mockRemoteId, kref)).toBeUndefined();
    });
  });
});
