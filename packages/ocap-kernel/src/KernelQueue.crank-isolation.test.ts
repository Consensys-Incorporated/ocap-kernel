import type { CapData } from '@endo/marshal';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { JsonRpcMessage } from '@metamask/kernel-utils';
import { Logger } from '@metamask/logger';
import type { DuplexStream } from '@metamask/streams';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import {
  kser,
  kunser,
  makeFatalKernelError,
} from './liveslots/kernel-marshal.ts';
import { initRemoteComms } from './remotes/kernel/remote-comms.ts';
import { OcapURLManager } from './remotes/kernel/OcapURLManager.ts';
import { RemoteManager } from './remotes/kernel/RemoteManager.ts';
import type { RemoteComms } from './remotes/types.ts';
import { makeKernelStore } from './store/index.ts';
import type {
  CrankResult,
  KRef,
  PlatformServices,
  RunLoopItem,
  VatConfig,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatManager } from './vats/VatManager.ts';
import { VatSyscall } from './vats/VatSyscall.ts';
import { asRRef, asVatId, asVRef } from '../test/branded.ts';

/*
 * Invariant M1: a crank aborts while writer X acts from outside it; X's effect
 * is not rolled back with it, but lands in a later crank of its own (or
 * survives).
 *
 * Rows titled "(gap, ...)" assert what main does today, which breaks the
 * invariant. A PR that closes a gap turns its row red and must rewrite it to
 * assert the invariant.
 */

vi.mock('./remotes/kernel/remote-comms.ts', async () => {
  const actual = await vi.importActual('./remotes/kernel/remote-comms.ts');
  return { ...actual, initRemoteComms: vi.fn() };
});

const STOP_RUN_LOOP = 'test: stop run loop';
const PEER_ID = '12D3KooWPeer1';
const NEW_PEER_ID = '12D3KooWPeer2';

type Harness = Awaited<ReturnType<typeof setUp>>;

/**
 * A real store and run loop, with every kind of writer wired to them. `v1` is
 * the vat whose delivery aborts; `v2` is a vat acting from outside that crank;
 * `v3` owns `target` and subscribes to `kpid`.
 *
 * @returns The pieces a row drives.
 */
async function setUp() {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  const config: VatConfig = { sourceSpec: 'test.js' };
  for (const vatId of ['v1', 'v2', 'v3'].map(asVatId)) {
    kernelStore.setVatConfig(vatId, config);
    kernelStore.initEndpoint(vatId);
  }
  const doomed = kernelStore.exportFromEndpoint(asVatId('v1'), asVRef('o+1'));
  const target = kernelStore.exportFromEndpoint(asVatId('v3'), asVRef('o+1'));
  const sentinel = kernelStore.exportFromEndpoint(asVatId('v3'), asVRef('o+2'));
  kernelStore.addCListEntry(asVatId('v2'), target, asVRef('o-1'));
  kernelStore.setReachableFlag(asVatId('v2'), target);
  const [kpid] = kernelStore.initKernelPromise();
  kernelStore.addPromiseSubscriber(asVatId('v3'), kpid);

  const kernelQueue = new KernelQueue(kernelStore, async (vatId) =>
    kernelStore.markVatAsTerminated(vatId),
  );

  const logger = new Logger('test');
  for (const level of ['log', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(logger, level).mockImplementation(() => undefined);
  }
  vi.spyOn(logger, 'subLogger').mockReturnValue(logger);
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  const platformServices = {
    launch: vi.fn().mockResolvedValue({
      end: vi.fn().mockResolvedValue(undefined),
    } as unknown as DuplexStream<JsonRpcMessage, JsonRpcMessage>),
    terminate: vi.fn().mockResolvedValue(undefined),
  } as unknown as PlatformServices;
  const vatManager = new VatManager({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
  });
  let failStream: (error: Error) => void = () => undefined;
  vi.spyOn(VatHandle, 'make').mockImplementationOnce(
    async ({ vatId, onStreamFailure }) => {
      failStream = onStreamFailure;
      return {
        vatId,
        config,
        terminate: vi.fn().mockResolvedValue(undefined),
      } as unknown as VatHandle;
    },
  );
  await vatManager.runVat(asVatId('v2'), config);
  const vatSyscall = new VatSyscall({
    vatId: asVatId('v2'),
    kernelQueue,
    kernelStore,
  });

  const persistedForPeer: [string, boolean][] = [];
  const set = kdb.kernelKVStore.set.bind(kdb.kernelKVStore);
  vi.spyOn(kdb.kernelKVStore, 'set').mockImplementation((key, value) => {
    if (key.startsWith('remotePending.')) {
      persistedForPeer.push([
        JSON.parse(value).method,
        kernelStore.isInCrank(),
      ]);
    }
    set(key, value);
  });

  const remoteComms = {
    getPeerId: vi.fn().mockReturnValue('local-peer'),
    addKnownRelays: vi.fn(),
    sendRemoteMessage: vi.fn().mockResolvedValue(undefined),
    registerLocationHints: vi.fn().mockResolvedValue(undefined),
  } as unknown as RemoteComms;
  vi.mocked(initRemoteComms).mockResolvedValue(remoteComms);
  const remoteManager = new RemoteManager({
    platformServices,
    kernelStore,
    kernelQueue,
    logger,
  });
  remoteManager.setMessageHandler(vi.fn());
  await remoteManager.initRemoteComms();
  const initArgs = vi.mocked(initRemoteComms).mock.lastCall ?? [];
  const onGiveUp = initArgs[6] as (peerId: string) => void;
  const onIncarnationChange = initArgs[8] as (
    peerId: string,
    incarnation: string,
  ) => Promise<boolean>;
  expect(onGiveUp).toBeTypeOf('function');
  expect(onIncarnationChange).toBeTypeOf('function');
  const remote = remoteManager.establishRemote(PEER_ID);

  return {
    kernelStore,
    kernelQueue,
    vatManager,
    vatSyscall,
    remoteManager,
    remote,
    persistedForPeer,
    onGiveUp,
    onIncarnationChange,
    failStream,
    doomed,
    target,
    sentinel,
    kpid,
  };
}

/**
 * Run the loop over one delivery to `v1` that aborts, with `act` running while
 * that crank is open, then let the loop drain whatever `act` left behind.
 *
 * @param harness - What {@link setUp} returned.
 * @param act - The writer acting from outside the crank.
 * @param options - Options bag.
 * @param options.answer - What `target` answers a message with, if anything.
 * @returns The items delivered after the aborted crank.
 */
async function abortACrankWhile(
  harness: Harness,
  act: () => Promise<void>,
  { answer }: { answer?: CapData<KRef> } = {},
): Promise<RunLoopItem[]> {
  const { kernelQueue, vatManager, remoteManager, doomed, target, sentinel } =
    harness;
  kernelQueue.enqueueSend(doomed, {
    methargs: kser(['work', []]),
    result: null,
  });

  const delivered: RunLoopItem[] = [];
  let abortedOnce = false;
  let aborted = (): void => undefined;
  const abortDelivered = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const deliver = async (
    item: RunLoopItem,
  ): Promise<CrankResult | undefined> => {
    if (item.type === 'send' && item.target === doomed) {
      // The rollback put the send back; the router splats it at the dead vat.
      if (abortedOnce) {
        // Kept open, so that what a writer does a few microtasks later lands
        // in this crank.
        await delay(20);
        return undefined;
      }
      abortedOnce = true;
      await act();
      aborted();
      // What `VatHandle` reports for a delivery that failed.
      return {
        didDelivery: asVatId('v1'),
        abort: true,
        terminate: {
          vatId: asVatId('v1'),
          reject: true,
          info: makeFatalKernelError('INTERNAL_ERROR', 'delivery failed'),
        },
      };
    }
    if (item.type === 'send' && item.target === sentinel) {
      throw new Error(STOP_RUN_LOOP);
    }
    if (
      item.type === 'send' &&
      item.target === target &&
      answer &&
      item.message.result
    ) {
      kernelQueue.resolvePromises(
        undefined,
        [[item.message.result, false, answer]],
        false,
      );
    }
    if (item.type === 'terminateVat') {
      return await vatManager.performVatTermination(item.vatId, item.reason);
    }
    if (item.type === 'remoteInbound') {
      return await remoteManager
        .getRemote(item.remoteId)
        .deliverInbound(item.message);
    }
    if (item.type === 'peerIncarnation') {
      return remoteManager.applyIncarnationChange(item);
    }
    // Recorded only for the types the rows observe; anything new must be wired
    // to its real handler before a row can say what it did.
    if (!['send', 'notify', 'dropExports'].includes(item.type)) {
      throw new Error(`test deliver does not handle ${item.type}`);
    }
    delivered.push(item);
    return undefined;
  };

  const running = kernelQueue.run(deliver);
  // A writer that throws kills the loop instead of reaching the abort.
  await Promise.race([abortDelivered, running]);
  await kernelQueue.waitForCrank();
  // Behind anything the writer queued, so the loop delivers that first.
  // Arrivals take turns with the run queue, so only the writer's first arrival
  // is sure to come before it.
  kernelQueue.enqueueSend(sentinel, {
    methargs: kser(['stop', []]),
    result: null,
  });
  await expect(running).rejects.toThrow(STOP_RUN_LOOP);
  // A writer that waits for the crank may still be finishing.
  await delay(10);
  harness.remoteManager.cleanup();
  return delivered;
}

/**
 * @param delivered - Items the loop delivered.
 * @param target - The object of interest.
 * @returns The method of each send to `target`, in order.
 */
function methodsSentTo(delivered: RunLoopItem[], target: KRef): string[] {
  return delivered.flatMap((item) =>
    item.type === 'send' && item.target === target
      ? [(kunser(item.message.methargs) as [string])[0]]
      : [],
  );
}

/**
 * @param delivered - Items the loop delivered.
 * @param kpid - The promise of interest.
 * @returns The endpoint of each notify for `kpid`, in order.
 */
function notified(delivered: RunLoopItem[], kpid: KRef): string[] {
  return delivered.flatMap((item) =>
    item.type === 'notify' && item.kpid === kpid ? [item.endpointId] : [],
  );
}

/**
 * Hand `v2`'s syscall to the kernel as its worker would, asserting it was
 * accepted so that a refused syscall cannot pass for a lost one.
 *
 * @param vatSyscall - `v2`'s syscall handler.
 * @param vso - The syscall.
 */
function syscallFromV2(
  vatSyscall: VatSyscall,
  vso: Parameters<VatSyscall['handleSyscall']>[0],
): void {
  expect(vatSyscall.handleSyscall(vso)).toStrictEqual(['ok', null]);
}

/**
 * Persist one outbound message to the peer in a committed crank, as a send
 * routed to the remote would.
 *
 * @param harness - What {@link setUp} returned.
 * @returns The message as the store holds it.
 */
async function sendOneMessageToPeer(harness: Harness): Promise<string> {
  const { kernelStore, remote } = harness;
  kernelStore.startCrank();
  kernelStore.createCrankSavepoint('crank');
  kernelStore.createCrankSavepoint('delivery');
  const { afterCommit } = await remote.deliverMessage(asRRef('ro+1'), {
    methargs: { body: kser(['hello', []]).body, slots: [] },
    result: null,
  });
  kernelStore.endCrank();
  await afterCommit?.();
  const pending = kernelStore.getPendingMessage(remote.remoteId, 1);
  expect(pending).toBeTypeOf('string');
  return pending as string;
}

/**
 * Make `kpid` a promise the peer decides.
 *
 * @param harness - What {@link setUp} returned.
 */
function letPeerDecide(harness: Harness): void {
  const { kernelStore, remote, kpid } = harness;
  kernelStore.setPromiseDecider(kpid, remote.remoteId);
  kernelStore.addCListEntry(remote.remoteId, kpid, asRRef('rp+1'));
}

describe('a writer acting while a crank aborts', () => {
  it('queueMessage: the message lands in a crank of its own and its caller is answered', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, target } = harness;
    let answered: Promise<CapData<KRef>> | undefined;
    const delivered = await abortACrankWhile(
      harness,
      async () => {
        answered = kernelQueue.enqueueMessage(target, 'fromKernel', []);
        expect(kernelStore.runQueueLength()).toBe(0);
      },
      { answer: kser('answer') },
    );
    const results = delivered.flatMap((item) =>
      item.type === 'send' && item.target === target
        ? [item.message.result]
        : [],
    );
    expect({
      sent: methodsSentTo(delivered, target),
      answer: await answered,
      resultReused: results.includes(kernelStore.initKernelPromise()[0]),
    }).toStrictEqual({
      sent: ['fromKernel'],
      answer: kser('answer'),
      resultReused: false,
    });
  });

  it('new remote setup: the remote is set up once the aborted crank ends', async () => {
    const harness = await setUp();
    const { kernelStore, remote, remoteManager } = harness;
    let handled: Promise<string | null> | undefined;
    await abortACrankWhile(harness, async () => {
      handled = remoteManager.handleRemoteMessage(
        NEW_PEER_ID,
        JSON.stringify({ seq: 1, method: 'deliver', params: ['notify', []] }),
      );
      expect(kernelStore.getRemoteIDs()).toStrictEqual([remote.remoteId]);
    });
    expect(await handled).toBeNull();
    const [, newRemoteId] = kernelStore.getRemoteIDs();
    expect({
      peers: kernelStore
        .getRemoteIDs()
        .map((remoteId) => kernelStore.getRemoteInfo(remoteId)?.peerId),
      highestReceivedSeq:
        newRemoteId &&
        kernelStore.getRemoteSeqState(newRemoteId)?.highestReceivedSeq,
      nextRemoteIdReused: kernelStore.getNextRemoteId() === newRemoteId,
    }).toStrictEqual({
      peers: [PEER_ID, NEW_PEER_ID],
      highestReceivedSeq: 1,
      nextRemoteIdReused: false,
    });
  });

  it('ocap URL redemption, new peer: the remote and its request are written once the aborted crank ends', async () => {
    const harness = await setUp();
    const { kernelStore, remote, remoteManager } = harness;
    const ocapURLManager = new OcapURLManager({ remoteManager, kernelStore });
    await abortACrankWhile(harness, async () => {
      ocapURLManager
        .redeemOcapURL(`ocap:token@${NEW_PEER_ID}`)
        .catch(() => undefined);
      expect(kernelStore.getRemoteIDs()).toStrictEqual([remote.remoteId]);
    });
    const [, newRemoteId] = kernelStore.getRemoteIDs();
    expect({
      peers: kernelStore
        .getRemoteIDs()
        .map((remoteId) => kernelStore.getRemoteInfo(remoteId)?.peerId),
      request: newRemoteId && kernelStore.getPendingMessage(newRemoteId, 1),
    }).toStrictEqual({
      peers: [PEER_ID, NEW_PEER_ID],
      request: expect.stringContaining('redeemURL'),
    });
  });

  it('ocap URL redemption, known peer: its request is lost with the aborted crank (gap, #1171)', async () => {
    const harness = await setUp();
    const { kernelStore, remote, remoteManager, persistedForPeer } = harness;
    const ocapURLManager = new OcapURLManager({ remoteManager, kernelStore });
    await abortACrankWhile(harness, async () => {
      ocapURLManager
        .redeemOcapURL(`ocap:token@${PEER_ID}`)
        .catch(() => undefined);
    });
    expect({
      request: kernelStore.getPendingMessage(remote.remoteId, 1),
      persistedForPeer,
    }).toStrictEqual({
      request: undefined,
      persistedForPeer: [['redeemURL', true]],
    });
  });

  it('inbound remote message: the message lands in a crank of its own', async () => {
    const harness = await setUp();
    const { kernelStore, remote, remoteManager, target } = harness;
    const targetRRef = kernelStore.allocateErefForKref(remote.remoteId, target);
    const delivered = await abortACrankWhile(harness, async () => {
      expect(
        await remoteManager.handleRemoteMessage(
          PEER_ID,
          JSON.stringify({
            seq: 1,
            method: 'deliver',
            params: [
              'message',
              targetRRef,
              { methargs: kser(['fromPeer', []]), result: 'rp+2' },
            ],
          }),
        ),
      ).toBeNull();
      expect(kernelStore.runQueueLength()).toBe(0);
    });
    expect(methodsSentTo(delivered, target)).toStrictEqual(['fromPeer']);
  });

  it('peer ACK: the acknowledged message is restored with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { kernelStore, remote, remoteManager } = harness;
    const pending = await sendOneMessageToPeer(harness);
    await abortACrankWhile(harness, async () => {
      await remoteManager.handleRemoteMessage(
        PEER_ID,
        JSON.stringify({ ack: 1 }),
      );
      expect(kernelStore.getPendingMessage(remote.remoteId, 1)).toBeUndefined();
    });
    expect({
      pending: kernelStore.getPendingMessage(remote.remoteId, 1),
      startSeq: kernelStore.getRemoteSeqState(remote.remoteId)?.startSeq,
    }).toStrictEqual({ pending, startSeq: 1 });
  });

  it('peer give-up: its rejections are lost with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { kernelStore, kpid, onGiveUp } = harness;
    letPeerDecide(harness);
    const delivered = await abortACrankWhile(harness, async () => {
      onGiveUp(PEER_ID);
      expect(kernelStore.getKernelPromise(kpid).state).toBe('rejected');
    });
    expect({
      state: kernelStore.getKernelPromise(kpid).state,
      notified: notified(delivered, kpid),
    }).toStrictEqual({ state: 'unresolved', notified: [] });
  });

  it('peer incarnation change: the new incarnation and its rejections land in a crank of their own', async () => {
    const harness = await setUp();
    const { kernelStore, kpid, onIncarnationChange } = harness;
    letPeerDecide(harness);
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    const delivered = await abortACrankWhile(harness, async () => {
      expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
      expect(kernelStore.getPeerIncarnation(PEER_ID)).toBe('incarnation-A');
    });
    const { state, value } = kernelStore.getKernelPromise(kpid);
    expect({
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
      state,
      reason: value?.body,
      notified: notified(delivered, kpid),
    }).toStrictEqual({
      incarnation: 'incarnation-B',
      state: 'rejected',
      reason: expect.stringContaining('[KERNEL:PEER_RESTARTED]'),
      notified: ['v3'],
    });
  });

  it('vat async resolve: the resolution is lost with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { kernelStore, vatSyscall, kpid } = harness;
    kernelStore.setPromiseDecider(kpid, asVatId('v2'));
    kernelStore.addCListEntry(asVatId('v2'), kpid, asVRef('p+5'));
    const delivered = await abortACrankWhile(harness, async () => {
      syscallFromV2(vatSyscall, ['resolve', [['p+5', false, kser('done')]]]);
      expect(kernelStore.getKernelPromise(kpid).state).toBe('fulfilled');
    });
    expect({
      state: kernelStore.getKernelPromise(kpid).state,
      notified: notified(delivered, kpid),
    }).toStrictEqual({ state: 'unresolved', notified: [] });
  });

  it('vat async send: the message is lost with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { vatSyscall, target } = harness;
    const delivered = await abortACrankWhile(harness, async () => {
      syscallFromV2(vatSyscall, [
        'send',
        'o-1',
        { methargs: kser(['fromVat', []]), result: 'p+6' },
      ]);
    });
    expect(methodsSentTo(delivered, target)).toStrictEqual([]);
  });

  it('vat async dropImports: the drop is lost with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { kernelStore, vatSyscall, target } = harness;
    const delivered = await abortACrankWhile(harness, async () => {
      syscallFromV2(vatSyscall, ['dropImports', ['o-1']]);
      expect(kernelStore.getReachableFlag(asVatId('v2'), target)).toBe(false);
    });
    expect({
      reachable: kernelStore.getReachableFlag(asVatId('v2'), target),
      dropExports: delivered.filter((item) => item.type === 'dropExports'),
    }).toStrictEqual({ reachable: true, dropExports: [] });
  });

  it('lost-vat retirement, when the next crank aborts too: the vat stays retired', async () => {
    const harness = await setUp();
    const {
      kernelStore,
      kernelQueue,
      vatManager,
      failStream,
      doomed,
      sentinel,
    } = harness;
    kernelQueue.enqueueSend(doomed, {
      methargs: kser(['work', []]),
      result: null,
    });
    let doomedDeliveries = 0;
    const deliver = async (
      item: RunLoopItem,
    ): Promise<CrankResult | undefined> => {
      if (item.type === 'send' && item.target === doomed) {
        doomedDeliveries += 1;
        if (doomedDeliveries === 1) {
          failStream(new Error('stream died'));
          return { didDelivery: asVatId('v1'), abort: true };
        }
        if (doomedDeliveries === 2) {
          // Long enough for a retirement that waits for the crank to resume
          // inside this one.
          await delay(20);
          return { didDelivery: asVatId('v1'), abort: true };
        }
        return undefined;
      }
      if (item.type === 'send' && item.target === sentinel) {
        throw new Error(STOP_RUN_LOOP);
      }
      if (item.type === 'terminateVat') {
        return await vatManager.performVatTermination(item.vatId, item.reason);
      }
      return undefined;
    };

    const running = kernelQueue.run(deliver);
    await vi.waitFor(() => expect(doomedDeliveries).toBe(3));
    kernelQueue.enqueueSend(sentinel, {
      methargs: kser(['stop', []]),
      result: null,
    });
    await expect(running).rejects.toThrow(STOP_RUN_LOOP);
    harness.remoteManager.cleanup();

    expect({
      active: kernelStore.isVatActive(asVatId('v2')),
      terminated: kernelStore.getTerminatedVats().includes(asVatId('v2')),
    }).toStrictEqual({ active: false, terminated: true });
  });

  it('lost-vat retirement: the vat stays retired', async () => {
    const harness = await setUp();
    const { kernelStore, failStream } = harness;
    await abortACrankWhile(harness, async () => {
      failStream(new Error('stream died'));
    });
    expect({
      active: kernelStore.isVatActive(asVatId('v2')),
      terminated: kernelStore.getTerminatedVats().includes(asVatId('v2')),
    }).toStrictEqual({ active: false, terminated: true });
  });
});
