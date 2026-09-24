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
 * Bring a handle up over a store, which is how a restart reaches whatever the
 * previous incarnation left behind.
 *
 * @param kernelStore - The store to restore from.
 * @returns The handle and the comms its sends land in.
 */
function startOver(kernelStore: ReturnType<typeof makeKernelStore>): {
  remote: RemoteHandle;
  remoteComms: RemoteComms;
} {
  const factory = createMockRemotesFactory({
    remoteId: REMOTE_ID,
    remotePeerId: PEER_ID,
  });
  const remoteComms = factory.makeMockRemoteComms();
  const remote = RemoteHandle.make({
    remoteId: REMOTE_ID,
    peerId: PEER_ID,
    kernelStore,
    kernelQueue: factory.makeMockKernelQueue(),
    remoteComms,
    ackTimeoutMs: ACK_TIMEOUT_MS,
  });
  return { remote, remoteComms };
}

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
  const kernelStore = makeKernelStore(
    await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
  );
  const { remote, remoteComms } = startOver(kernelStore);
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
 * Let the outbound chain run to a standstill. Every send waits on the one
 * before it, whether a flush or a retransmission issued it, so a queue costs
 * several microtasks per message.
 */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
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
  // The run loop does not wait for the wire, so the sends `afterCommit` set
  // going are still queued behind one another when it returns.
  await drainMicrotasks();
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

/**
 * Make a delivery in a crank that commits and then goes no further, as a
 * kernel dying between the commit and `afterCommit` leaves one: written down
 * for good, and never handed to the transport.
 *
 * @param remote - The handle to deliver through.
 * @param kernelStore - The store the crank runs against.
 */
async function deliverAndDie(
  remote: RemoteHandle,
  kernelStore: ReturnType<typeof makeKernelStore>,
): Promise<void> {
  kernelStore.startCrank();
  kernelStore.createCrankSavepoint('crank');
  kernelStore.createCrankSavepoint('delivery');
  await remote.deliverBringOutYourDead();
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

    it('waits behind a delivery whose crank has yet to commit', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      // Numbered from the store, so it takes seq 2 while seq 1 awaits its
      // commit.
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([]);

      kernelStore.endCrank();
      await afterCommit?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2]);
    });

    it('keeps both messages on the retransmit list', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.endCrank();
      await afterCommit?.();

      pendingTimers[0]?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2, 1, 2]);
    });

    it('drops one whose crank aborted while it waited its turn', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      // Seq 1 never commits, so seq 2 is still waiting behind it when the
      // rollback takes both payloads back.
      await remote.deliverBringOutYourDead();
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();

      await deliverAndCommit(remote, kernelStore);

      // Sending the stranded seq 2 would spend a number on a payload the
      // kernel no longer has any record of.
      expect(sentSeqs(remoteComms)).toStrictEqual([1]);
    });

    it('records where the store’s queue begins', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();

      await deliverAndCommit(remote, kernelStore);

      // Memory still holds the rolled-back seq 1, but the store's queue really
      // does begin at 2, and a restart reads the store.
      expect(kernelStore.getRemoteSeqState(REMOTE_ID)).toMatchObject({
        startSeq: 2,
        nextSendSeq: 2,
      });
    });
  });

  describe('a delivery a give-up lands on top of', () => {
    /**
     * Give up between a delivery's persist and its commit, where the transport
     * puts one: its failure handling is detached from the send, and the run
     * loop awaits in that interval.
     *
     * @param remote - The handle to deliver through.
     * @param kernelStore - The store the crank runs against.
     */
    async function deliverAndGiveUp(
      remote: RemoteHandle,
      kernelStore: ReturnType<typeof makeKernelStore>,
    ): Promise<void> {
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await remote.deliverBringOutYourDead();
      remote.giveUp('not acknowledged after 3 retries');
      kernelStore.endCrank();
      await afterCommit?.();
    }

    it('does not go to a peer whose promises the give-up rejected', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndGiveUp(remote, kernelStore);

      expect(sentSeqs(remoteComms)).toStrictEqual([]);
    });

    it('leaves the delivery after a rolled-back give-up a number of its own', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndCommit(remote, kernelStore);
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      await remote.deliverBringOutYourDead();
      remote.giveUp('not acknowledged after 3 retries');
      // The give-up's own writes are inside the crank, so the store keeps a
      // queue the handle has stopped counting on.
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();

      await deliverAndCommit(remote, kernelStore);

      // Numbered below what the give-up abandoned, seq 2 would be taken for
      // one of the messages it abandoned and dropped in its turn.
      expect(sentSeqs(remoteComms)).toStrictEqual([1, 3]);
    });

    it('leaves the delivery after it a number of its own', async () => {
      const { remote, kernelStore, remoteComms } =
        await makeRemoteOverRealStore();

      await deliverAndGiveUp(remote, kernelStore);
      await deliverAndCommit(remote, kernelStore);

      // Seq 1 is spent on the abandoned message, and nothing waits behind it.
      expect(sentSeqs(remoteComms)).toStrictEqual([2]);
    });
  });

  describe('a delivery a restart inherits', () => {
    it('goes out ahead of the one numbered after it', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      await deliverAndDie(remote, kernelStore);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      await deliverAndCommit(restarted, kernelStore);

      // Seq 2 first and the peer takes it for the next it was owed, drops seq
      // 1 as a duplicate when the timeout retransmits it, and acknowledges
      // both.
      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2]);
    });

    it('takes the whole queue with it, in order', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      await deliverAndCommit(remote, kernelStore);
      await deliverAndDie(remote, kernelStore);
      await deliverAndDie(remote, kernelStore);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      await deliverAndCommit(restarted, kernelStore);

      // Seq 1 did reach the peer before the crash, but nothing records that,
      // and a duplicate costs the peer only the drop.
      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2, 3, 4]);

      // Sending the queue must not move the start of it. Were `#startSeq`
      // walked up to seq 3, the retransmit would begin there and the two
      // messages ahead of it would never go out again. The last timer armed is
      // the restarted handle's; the first belongs to the incarnation that died.
      pendingTimers.at(-1)?.();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2, 3, 4, 1, 2, 3, 4]);
    });

    it('sends the first message of a queue a restart found empty', async () => {
      const { kernelStore } = await makeRemoteOverRealStore();
      // One key of the three, so the record exists with both counters at zero
      // and the no-seq-state branch does not catch it.
      kernelStore.setRemoteHighestReceivedSeq(REMOTE_ID, 2);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      await deliverAndCommit(restarted, kernelStore);

      expect(sentSeqs(remoteComms)).toStrictEqual([1]);
    });

    it('sends the first delivery after a restart that followed a give-up', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();
      // Memory holds the seq 1 the peer has and the store does not, so the
      // give-up abandons a queue only memory knows the length of.
      remote.giveUp('not acknowledged after 3 retries');

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      await deliverAndCommit(restarted, kernelStore);

      // Leave the store a queue whose start has outrun its end and the restart
      // numbers this seq 1, behind a watermark that was set from the start.
      expect(sentSeqs(remoteComms)).toStrictEqual([2]);
    });

    it('moves on from a hole a rolled-back mid-crank send left in it', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      await deliverAndCommit(remote, kernelStore);
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      remote.redeemOcapURL('ocap:abc123@somepeer').catch(() => undefined);
      await drainMicrotasks();
      kernelStore.rollbackCrank('delivery');
      kernelStore.endCrank();
      // Numbered from memory, which the rollback did not reach, so the store
      // is left holding seq 1 and seq 3 with nothing at seq 2.
      await deliverAndDie(remote, kernelStore);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      await deliverAndCommit(restarted, kernelStore);

      // Nothing will ever take seq 2. Waiting for it would strand seq 3 and
      // every message after it for the life of the incarnation.
      expect(sentSeqs(remoteComms)).toStrictEqual([1, 3, 4]);
    });

    it('hands it over one message at a time', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      await deliverAndDie(remote, kernelStore);
      await deliverAndDie(remote, kernelStore);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      // The transport dials and shakes hands on the first message of a cold
      // channel, which a restart always has. A second sent meanwhile finds
      // that channel registered and writes first.
      let letTheFirstSendFinish = (): void => undefined;
      vi.mocked(remoteComms.sendRemoteMessage).mockReturnValueOnce(
        new Promise((resolve) => {
          letTheFirstSendFinish = () => resolve(undefined);
        }),
      );

      await deliverAndCommit(restarted, kernelStore);

      expect(sentSeqs(remoteComms)).toStrictEqual([1]);

      letTheFirstSendFinish();
      await drainMicrotasks();

      expect(sentSeqs(remoteComms)).toStrictEqual([1, 2, 3]);
    });

    it('steps over the part of it the peer acknowledges meanwhile', async () => {
      const { remote, kernelStore } = await makeRemoteOverRealStore();

      await deliverAndDie(remote, kernelStore);

      const { remote: restarted, remoteComms } = startOver(kernelStore);
      kernelStore.startCrank();
      kernelStore.createCrankSavepoint('crank');
      kernelStore.createCrankSavepoint('delivery');
      const { afterCommit } = await restarted.deliverBringOutYourDead();
      // Seq 1 did reach the peer, whose acknowledgement arrives on the
      // transport's flow, so it can land here.
      restarted.receiveFromPeer(JSON.stringify({ ack: 1 }));
      kernelStore.endCrank();
      await afterCommit?.();

      // Nothing is owed at seq 1 and nothing will take that number, so seq 2
      // must not wait behind it.
      expect(sentSeqs(remoteComms)).toStrictEqual([2]);
    });
  });
});
