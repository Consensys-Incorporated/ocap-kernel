import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import { describe, it, expect, onTestFinished, vi } from 'vitest';

import { initRemoteComms } from './remote-comms.ts';
import { RemoteManager } from './RemoteManager.ts';
import { asRRef } from '../../../test/branded.ts';
import { KernelQueue } from '../../KernelQueue.ts';
import { makeKernelStore } from '../../store/index.ts';
import type {
  CrankResult,
  KRef,
  PlatformServices,
  RunLoopItem,
} from '../../types.ts';
import type { RemoteComms } from '../types.ts';

vi.mock('./remote-comms.ts', async () => {
  const actual = await vi.importActual('./remote-comms.ts');
  return { ...actual, initRemoteComms: vi.fn() };
});

const PEER_ID = '12D3KooWPeer1';

type Hooks = {
  /** Awaited before the run loop's delivery of each item. */
  beforeDelivery?: (item: RunLoopItem) => Promise<void>;
  /** Awaited once an incarnation change is recorded, before its commit. */
  afterApply?: (item: RunLoopItem) => Promise<void>;
};

/**
 * A real store and run loop, a RemoteManager over them, and a remote for
 * `PEER_ID`.
 *
 * @returns The pieces a test drives.
 */
async function setUp() {
  const kernelStore = makeKernelStore(
    await makeSQLKernelDatabase({ dbFilename: ':memory:' }),
  );
  const kernelQueue = new KernelQueue(kernelStore, async () => undefined);
  const logger = new Logger('test');
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
  const sent: string[] = [];
  const remoteComms = {
    getPeerId: vi.fn().mockReturnValue('local-peer'),
    sendRemoteMessage: vi.fn(async (_to: string, message: string) => {
      sent.push(message);
    }),
    registerLocationHints: vi.fn().mockResolvedValue(undefined),
  } as unknown as RemoteComms;
  vi.mocked(initRemoteComms).mockResolvedValue(remoteComms);
  const remoteManager = new RemoteManager({
    platformServices: {} as PlatformServices,
    kernelStore,
    kernelQueue,
    logger,
  });
  remoteManager.setMessageHandler(vi.fn());
  await remoteManager.initRemoteComms();
  onTestFinished(() => remoteManager.cleanup());
  const onRemoteGiveUp = vi.mocked(initRemoteComms).mock.lastCall?.[6] as (
    peerId: string,
  ) => void;
  const onIncarnationChange = vi.mocked(initRemoteComms).mock.lastCall?.[8] as (
    peerId: string,
    incarnation: string,
  ) => Promise<boolean>;
  const remote = remoteManager.establishRemote(PEER_ID);

  const hooks: Hooks = {};
  // Each sequence number a crank took delivery of, rather than dropped.
  const taken: number[] = [];
  const deliver = async (
    item: RunLoopItem,
  ): Promise<CrankResult | undefined> => {
    if (hooks.beforeDelivery) {
      await hooks.beforeDelivery(item);
    }
    if (item.type === 'remoteInbound') {
      const result = await remoteManager
        .getRemote(item.remoteId)
        .deliverInbound(item.message);
      if (result.afterCommit) {
        taken.push(item.seq);
      }
      return result;
    }
    if (item.type === 'peerIncarnation') {
      const result = remoteManager.applyIncarnationChange(item);
      if (hooks.afterApply) {
        await hooks.afterApply(item);
      }
      return result;
    }
    return undefined;
  };

  return {
    kernelStore,
    kernelQueue,
    remoteManager,
    remote,
    onRemoteGiveUp,
    onIncarnationChange,
    hooks,
    taken,
    sent,
    startRunLoop: async () => kernelQueue.run(deliver),
  };
}

/**
 * A message from the peer that writes nothing beyond its own receipt.
 *
 * @param seq - Its sequence number.
 * @returns The message as it arrives.
 */
function emptyNotify(seq: number): string {
  return JSON.stringify({ seq, method: 'deliver', params: ['notify', []] });
}

/**
 * Let the run loop take everything waiting.
 */
async function settle(): Promise<void> {
  await delay(20);
}

/**
 * Keep the run loop inside the next crank it takes until released, so what
 * arrives meanwhile waits.
 *
 * @param hooks - The harness's hooks.
 * @returns A function that lets the crank go on.
 */
function holdNextCrank(hooks: Hooks): () => void {
  let release!: () => void;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  hooks.beforeDelivery = async () => {
    delete hooks.beforeDelivery;
    await released;
  };
  return release;
}

/**
 * @param sent - The messages the remote handed to the transport.
 * @returns The sequence number of each, in order.
 */
function sentSeqs(sent: string[]): number[] {
  return sent.flatMap((message) => {
    const { seq } = JSON.parse(message) as { seq?: number };
    return seq === undefined ? [] : [seq];
  });
}

/**
 * Make a promise the remote decides.
 *
 * @param harness - The harness.
 * @returns The promise's kpid.
 */
function promiseThePeerDecides(
  harness: Awaited<ReturnType<typeof setUp>>,
): KRef {
  const { kernelStore, remote } = harness;
  const [kpid] = kernelStore.initKernelPromise();
  kernelStore.setPromiseDecider(kpid, remote.remoteId);
  kernelStore.addCListEntry(remote.remoteId, kpid, asRRef('rp+1'));
  return kpid;
}

describe('a peer incarnation change on the run loop', () => {
  it('takes a message read off the old channel after the restart handshake against the old incarnation', async () => {
    const harness = await setUp();
    const { remoteManager, onIncarnationChange, hooks, taken, sent } = harness;
    harness.startRunLoop().catch(() => undefined);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2, 3]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();

    const release = holdNextCrank(hooks);
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(4));
    await settle();
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    // The old channel still holds a message, which its reader hands over
    // while the change waits.
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(5));
    release();
    await settle();
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(false);
    for (const seq of [1, 2, 3, 4, 5]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();
    // The delayed standalone ACK.
    await delay(100);

    expect({ taken, lastSent: sent.at(-1) }).toStrictEqual({
      taken: [1, 2, 3, 4, 5, 1, 2, 3, 4, 5],
      lastSent: '{"ack":5}',
    });
  });

  it('drops a copy of a taken message read off the old channel after the restart handshake', async () => {
    const harness = await setUp();
    const { remoteManager, onIncarnationChange, hooks, taken } = harness;
    harness.startRunLoop().catch(() => undefined);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2, 3]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();

    const release = holdNextCrank(hooks);
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(4));
    await settle();
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(2));
    release();
    await settle();

    expect(taken).toStrictEqual([1, 2, 3, 4]);
  });

  it('drops a copy of a taken message read off the old channel while the restart’s crank is open', async () => {
    const harness = await setUp();
    const { remoteManager, onIncarnationChange, hooks, taken, sent } = harness;
    harness.startRunLoop().catch(() => undefined);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2, 3]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();
    hooks.afterApply = async () => {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(3));
    };

    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    await settle();
    for (const seq of [1, 2, 3, 4]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();
    // The delayed standalone ACK.
    await delay(100);

    expect({ taken, lastSent: sent.at(-1) }).toStrictEqual({
      taken: [1, 2, 3, 1, 2, 3, 4],
      lastSent: '{"ack":4}',
    });
  });

  it('reports the restart to a handshake made while its crank is open', async () => {
    const harness = await setUp();
    const { remoteManager, onIncarnationChange, hooks, taken } = harness;
    harness.startRunLoop().catch(() => undefined);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2, 3]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();
    let inTheCrank: boolean | undefined;
    hooks.afterApply = async () => {
      inTheCrank = await onIncarnationChange(PEER_ID, 'incarnation-B');
    };

    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    await settle();
    const afterTheCommit = await onIncarnationChange(PEER_ID, 'incarnation-B');
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(1));
    await settle();

    expect({ inTheCrank, afterTheCommit, taken }).toStrictEqual({
      inTheCrank: true,
      afterTheCommit: false,
      taken: [1, 2, 3, 1],
    });
  });

  it('takes what the first incarnation sent ahead of a restart reported before it was recorded', async () => {
    const harness = await setUp();
    const { remoteManager, onIncarnationChange, taken } = harness;
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    // Read late off the first incarnation's channel.
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(3));
    harness.startRunLoop().catch(() => undefined);
    await settle();
    for (const seq of [1, 2, 3]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();

    expect(taken).toStrictEqual([1, 2, 3, 1, 2, 3]);
  });

  it('reports no restart to a re-dial of a first incarnation still waiting to be recorded', async () => {
    const harness = await setUp();
    const { kernelStore, remote, onIncarnationChange, sent } = harness;
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    harness.startRunLoop().catch(() => undefined);
    await settle();
    remote.redeemOcapURL('ocap:y@peer').catch(() => undefined);
    await delay(5);

    expect({
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
      sent: sentSeqs(sent),
    }).toStrictEqual({ incarnation: 'incarnation-A', sent: [1] });
  });

  it('holds what it sends to a peer that restarts before its first incarnation is recorded', async () => {
    const harness = await setUp();
    const { kernelStore, remote, onIncarnationChange, sent } = harness;
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(false);

    expect(await onIncarnationChange(PEER_ID, 'incarnation-C')).toBe(true);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-C')).toBe(true);
    remote.redeemOcapURL('ocap:x@peer').catch(() => undefined);
    await delay(5);
    expect(sentSeqs(sent)).toStrictEqual([]);

    harness.startRunLoop().catch(() => undefined);
    await settle();
    remote.redeemOcapURL('ocap:y@peer').catch(() => undefined);
    await delay(5);

    expect({
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
      sent: sentSeqs(sent),
    }).toStrictEqual({ incarnation: 'incarnation-C', sent: [1] });
  });

  it('holds what it sends between a restart’s crank and a later restart’s', async () => {
    const harness = await setUp();
    const { kernelStore, remote, onIncarnationChange, hooks, sent } = harness;
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    expect(await onIncarnationChange(PEER_ID, 'incarnation-C')).toBe(true);
    // C took B's place, so a later restart is reported while C's crank is open.
    hooks.afterApply = async () => {
      delete hooks.afterApply;
      expect(await onIncarnationChange(PEER_ID, 'incarnation-D')).toBe(true);
    };
    let sentBetween: number[] | undefined;
    hooks.beforeDelivery = async (item) => {
      if (
        item.type === 'peerIncarnation' &&
        item.incarnation === 'incarnation-D'
      ) {
        remote.redeemOcapURL('ocap:between@peer').catch(() => undefined);
        await delay(5);
        sentBetween = sentSeqs(sent);
      }
    };
    harness.startRunLoop().catch(() => undefined);
    await settle();

    expect({
      sentBetween,
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
    }).toStrictEqual({ sentBetween: [], incarnation: 'incarnation-D' });
  });

  it('rejects the promises the peer decides inside the crank, and answers their callers at its flush', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, onIncarnationChange, hooks } = harness;
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    const kpid = promiseThePeerDecides(harness);
    let answered = false;
    const answer = (): void => {
      answered = true;
    };
    kernelQueue.subscriptions.set(kpid, { resolve: answer, reject: answer });
    let inTheCrank: { state: string; answered: boolean } | undefined;
    hooks.afterApply = async () => {
      inTheCrank = {
        state: kernelStore.getKernelPromise(kpid).state,
        answered,
      };
    };
    harness.startRunLoop().catch(() => undefined);
    await onIncarnationChange(PEER_ID, 'incarnation-B');
    await settle();

    expect({ inTheCrank, answered }).toStrictEqual({
      inTheCrank: { state: 'rejected', answered: false },
      answered: true,
    });
  });

  it('leaves the peer’s promises to the restart’s crank when the transport gives up while it waits', async () => {
    const harness = await setUp();
    const {
      kernelStore,
      remoteManager,
      onRemoteGiveUp,
      onIncarnationChange,
      hooks,
    } = harness;
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    const kpid = promiseThePeerDecides(harness);
    // Pinned, or the c-list's teardown collects it before it can be read.
    kernelStore.incrementRefCount(kpid, 'test|pin');
    harness.startRunLoop().catch(() => undefined);
    const release = holdNextCrank(hooks);
    await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(1));
    await settle();
    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    onRemoteGiveUp(PEER_ID);
    release();
    await settle();

    const { state, value } = kernelStore.getKernelPromise(kpid);
    expect({ state, reason: value?.body }).toStrictEqual({
      state: 'rejected',
      reason: expect.stringContaining('[KERNEL:PEER_RESTARTED]'),
    });
  });

  it('keeps sending once something writes the send window while the restart’s crank is open', async () => {
    const harness = await setUp();
    const { kernelStore, remote, onIncarnationChange, hooks, sent } = harness;
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    harness.startRunLoop().catch(() => undefined);
    remote.redeemOcapURL('ocap:before@peer').catch(() => undefined);
    await settle();
    // A transport give-up whose turn comes while the crank is open.
    hooks.afterApply = async () => {
      remote.giveUp('connection lost');
    };

    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
    await settle();
    remote.redeemOcapURL('ocap:after@peer').catch(() => undefined);
    await delay(5);

    expect(sentSeqs(sent)).toStrictEqual([1, 1]);
  });

  it('stops the run loop when the restart cannot be recorded, keeping the old session', async () => {
    const harness = await setUp();
    const { kernelStore, remoteManager, remote, onIncarnationChange } = harness;
    const running = harness.startRunLoop();
    expect(await onIncarnationChange(PEER_ID, 'incarnation-A')).toBe(false);
    for (const seq of [1, 2]) {
      await remoteManager.handleRemoteMessage(PEER_ID, emptyNotify(seq));
    }
    await settle();
    // Partway through the teardown, after its first write.
    vi.spyOn(remote, 'persistPeerRestart').mockImplementation(() => {
      kernelStore.clearRemoteSeqState(remote.remoteId);
      throw new Error('refcount underflow');
    });

    expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);

    await expect(running).rejects.toThrow('refcount underflow');
    expect({
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
      highestReceivedSeq: kernelStore.getRemoteSeqState(remote.remoteId)
        ?.highestReceivedSeq,
    }).toStrictEqual({ incarnation: 'incarnation-A', highestReceivedSeq: 2 });
  });
});
