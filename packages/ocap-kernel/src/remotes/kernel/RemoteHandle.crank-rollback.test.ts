import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { RemoteHandle } from './RemoteHandle.ts';
import { createMockRemotesFactory } from '../../../test/remotes-mocks.ts';
import { makeKernelStore } from '../../store/index.ts';
import type { RemoteComms } from '../types.ts';

const REMOTE_ID = 'r0';
const PEER_ID = 'remote-peer-id';
/** `MAX_PENDING_MESSAGES`, which RemoteHandle keeps to itself. */
const CAPACITY = 200;
const ACK_TIMEOUT_MS = 100;

/**
 * A handle over a real store, since a rollback is what is under test and the
 * map-backed test database treats savepoints as no-ops.
 *
 * @returns The handle, its store, and the comms its sends land in.
 */
async function makeRemoteOverRealStore(): Promise<{
  remote: RemoteHandle;
  kernelStore: ReturnType<typeof makeKernelStore>;
  remoteComms: RemoteComms;
}> {
  const factory = createMockRemotesFactory({
    remoteId: REMOTE_ID,
    remotePeerId: PEER_ID,
  });
  const kernelStore = makeKernelStore(
    await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
  );
  const remoteComms = factory.makeMockRemoteComms();
  const remote = RemoteHandle.make({
    remoteId: REMOTE_ID,
    peerId: PEER_ID,
    kernelStore,
    kernelQueue: factory.makeMockKernelQueue(),
    remoteComms,
    ackTimeoutMs: ACK_TIMEOUT_MS,
  });
  kernelStore.initEndpoint(REMOTE_ID);
  return { remote, kernelStore, remoteComms };
}

/**
 * The sequence numbers the peer has seen, in the order it saw them.
 *
 * @param remoteComms - The comms the sends went through.
 * @returns One sequence number per send.
 */
function sentSeqs(remoteComms: RemoteComms): number[] {
  return vi
    .mocked(remoteComms.sendRemoteMessage)
    .mock.calls.map(([, messageString]) => JSON.parse(messageString).seq);
}

/**
 * Let a retransmission run to completion: it awaits each send before the next,
 * so one message costs several microtasks.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await Promise.resolve();
  }
}

/**
 * Make a delivery in a crank of its own and commit it, the way the run loop
 * does.
 *
 * @param remote - The handle to deliver through.
 * @param kernelStore - The store the crank runs against.
 */
async function deliverAndCommit(
  remote: RemoteHandle,
  kernelStore: ReturnType<typeof makeKernelStore>,
): Promise<void> {
  kernelStore.startCrank();
  kernelStore.createCrankSavepoint('crank');
  kernelStore.createCrankSavepoint('delivery');
  const { afterCommit } = await remote.deliverBringOutYourDead();
  kernelStore.endCrank();
  await afterCommit?.();
}

/**
 * Make a delivery in a crank that then rolls back, the way the run loop does
 * for one that aborts: the message is written down and `afterCommit` withheld.
 *
 * @param remote - The handle to deliver through.
 * @param kernelStore - The store the crank runs against.
 */
async function deliverAndRollBack(
  remote: RemoteHandle,
  kernelStore: ReturnType<typeof makeKernelStore>,
): Promise<void> {
  kernelStore.startCrank();
  kernelStore.createCrankSavepoint('crank');
  kernelStore.createCrankSavepoint('delivery');
  await remote.deliverBringOutYourDead();
  kernelStore.rollbackCrank('delivery');
  kernelStore.endCrank();
}

describe('RemoteHandle across a crank boundary', () => {
  // SES lockdown freezes Date, so vi.useFakeTimers() cannot be used here.
  const pendingTimers: (() => void)[] = [];
  let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    pendingTimers.length = 0;
    setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
      delay: number,
    ) => {
      // Only the ACK timer, not the 50 ms delayed-ACK one, whose standalone
      // acknowledgement would be counted as a retransmission.
      if (delay === ACK_TIMEOUT_MS) {
        pendingTimers.push(callback);
      }
      return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
    }) as typeof setTimeout);
  });

  afterEach(() => {
    setTimeoutSpy.mockRestore();
  });

  describe('a delivery whose crank rolls back', () => {
    it('leaves the sequence counters where the crank found them', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndRollBack(remote, kernelStore);

      expect(kernelStore.getPendingMessage(REMOTE_ID, 1)).toBeUndefined();

      await deliverAndCommit(remote, kernelStore);

      expect(sentSeqs(remoteComms)).toStrictEqual([1]);
    });

    it('leaves the next delivery an ACK timeout to retransmit under', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndRollBack(remote, kernelStore);
      await deliverAndCommit(remote, kernelStore);

      expect(pendingTimers).toHaveLength(1);
      pendingTimers[0]?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 1]);
    });

    it('leaves a queue that was already occupied where the crank found it', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndCommit(remote, kernelStore);
      await deliverAndCommit(remote, kernelStore);
      await deliverAndRollBack(remote, kernelStore);
      await deliverAndCommit(remote, kernelStore);

      // No hole at 3: the retransmit covers exactly what the peer was sent.
      pendingTimers[0]?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2, 3, 1, 2, 3]);
    });

    it('stops counting a message it took back against the capacity limit', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      for (let i = 0; i < CAPACITY; i += 1) {
        await remote.deliverBringOutYourDead();
      }
      await expect(remote.deliverBringOutYourDead()).rejects.toThrow(
        `pending queue at capacity (${CAPACITY})`,
      );
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();

      await deliverAndCommit(remote, kernelStore);

      expect(sentSeqs(remoteComms)).toStrictEqual([1]);
    });
  });

  describe('a delivery the peer restarts out from under', () => {
    it('does not send what the restart retired', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      kernelStore.endCrank();
      // The handshake runs on the transport's flow, so it can land here.
      remote.persistPeerRestart();
      remote.finalizePeerRestart();
      await afterCommit?.();

      expect(sentSeqs(remoteComms)).toStrictEqual([]);
    });

    it('leaves seq 1 for the incarnation that is starting', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      kernelStore.endCrank();
      remote.persistPeerRestart();
      remote.finalizePeerRestart();
      await afterCommit?.();

      await deliverAndCommit(remote, kernelStore);

      // Had the retired message gone out as seq 1, the new incarnation would
      // have taken it for the first and dropped this one as a duplicate.
      expect(sentSeqs(remoteComms)).toStrictEqual([1]);
    });
  });

  describe('a message sent mid-crank, which a rollback cannot recall', () => {
    it('does not hand its sequence number out a second time', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      // A request that awaits the peer's reply goes out to get one, so it is on
      // the wire before the crank that made it commits.
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();

      await deliverAndCommit(remote, kernelStore);

      // Seq 1 is spent whatever the store now says: the peer's duplicate filter
      // would drop a second one, and its ACK would retire this one in its place.
      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2]);
    });

    it('keeps track of one that overtakes a delivery awaiting its commit', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      // Numbered from the store, so it takes seq 2 and goes out first.
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.endCrank();
      await afterCommit?.();

      // Both are the handle's to retransmit; neither may be left off the list
      // because the other moved the counters first.
      pendingTimers[0]?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([2, 1, 1, 2]);
    });
  });
});
