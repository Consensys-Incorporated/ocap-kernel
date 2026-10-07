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
import { RemoteManager } from './remotes/kernel/RemoteManager.ts';
import type { RemoteComms } from './remotes/types.ts';
import { makeKernelStore } from './store/index.ts';
import type {
  CrankResult,
  KRef,
  PlatformServices,
  RunQueueItem,
  VatConfig,
} from './types.ts';
import { VatHandle } from './vats/VatHandle.ts';
import { VatManager } from './vats/VatManager.ts';
import { VatSyscall } from './vats/VatSyscall.ts';

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
// Base58, like a real one: it ends up in a savepoint name.
const PEER_ID = '12D3KooWPeer1';

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
  for (const vatId of ['v1', 'v2', 'v3']) {
    kernelStore.setVatConfig(vatId, config);
    kernelStore.initEndpoint(vatId);
  }
  const doomed = kernelStore.exportFromEndpoint('v1', 'o+1');
  const target = kernelStore.exportFromEndpoint('v3', 'o+1');
  const sentinel = kernelStore.exportFromEndpoint('v3', 'o+2');
  kernelStore.addCListEntry('v2', target, 'o-1');
  kernelStore.setReachableFlag('v2', target);
  const [kpid] = kernelStore.initKernelPromise();
  kernelStore.addPromiseSubscriber('v3', kpid);

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
  await vatManager.runVat('v2', config);
  const vatSyscall = new VatSyscall({ vatId: 'v2', kernelQueue, kernelStore });

  const remoteComms = {
    getPeerId: vi.fn().mockReturnValue('local-peer'),
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
    vatSyscall,
    remoteManager,
    remote,
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
 * @returns The items delivered after the aborted crank.
 */
async function abortACrankWhile(
  harness: Harness,
  act: () => Promise<void>,
): Promise<RunQueueItem[]> {
  const { kernelQueue, doomed, sentinel } = harness;
  kernelQueue.enqueueSend(doomed, {
    methargs: kser(['work', []]),
    result: null,
  });

  const delivered: RunQueueItem[] = [];
  let abortedOnce = false;
  let aborted = (): void => undefined;
  const abortDelivered = new Promise<void>((resolve) => {
    aborted = resolve;
  });
  const deliver = async (
    item: RunQueueItem,
  ): Promise<CrankResult | undefined> => {
    if (item.type === 'send' && item.target === doomed) {
      // The rollback put the send back; the router splats it at the dead vat.
      if (abortedOnce) {
        return undefined;
      }
      abortedOnce = true;
      await act();
      aborted();
      // What `VatHandle` reports for a delivery that failed.
      return {
        didDelivery: 'v1',
        abort: true,
        terminate: {
          vatId: 'v1',
          reject: true,
          info: makeFatalKernelError('INTERNAL_ERROR', 'delivery failed'),
        },
      };
    }
    if (item.type === 'send' && item.target === sentinel) {
      throw new Error(STOP_RUN_LOOP);
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
function methodsSentTo(delivered: RunQueueItem[], target: KRef): string[] {
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
function notified(delivered: RunQueueItem[], kpid: KRef): string[] {
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
  const { afterCommit } = await remote.deliverMessage('ro+1', {
    methargs: kser(['hello', []]),
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
  kernelStore.addCListEntry(remote.remoteId, kpid, 'rp+1');
}

describe('a writer acting while a crank aborts', () => {
  it('queueMessage: the message is lost with the aborted crank (gap)', async () => {
    const harness = await setUp();
    const { kernelStore, kernelQueue, target } = harness;
    const delivered = await abortACrankWhile(harness, async () => {
      kernelQueue
        .enqueueMessage(target, 'fromKernel', [])
        .catch(() => undefined);
      expect(kernelStore.runQueueLength()).toBe(1);
    });
    expect(methodsSentTo(delivered, target)).toStrictEqual([]);
  });

  it('inbound remote message: the message is lost with the aborted crank (gap, #1103)', async () => {
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
      expect(kernelStore.runQueueLength()).toBe(1);
    });
    expect(methodsSentTo(delivered, target)).toStrictEqual([]);
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

  it('peer incarnation change: the new incarnation and its rejections are lost with the aborted crank (gap, #1104)', async () => {
    const harness = await setUp();
    const { kernelStore, kpid, onIncarnationChange } = harness;
    letPeerDecide(harness);
    kernelStore.setPeerIncarnation(PEER_ID, 'incarnation-A');
    const delivered = await abortACrankWhile(harness, async () => {
      expect(await onIncarnationChange(PEER_ID, 'incarnation-B')).toBe(true);
      expect(kernelStore.getPeerIncarnation(PEER_ID)).toBe('incarnation-B');
    });
    expect({
      incarnation: kernelStore.getPeerIncarnation(PEER_ID),
      state: kernelStore.getKernelPromise(kpid).state,
      notified: notified(delivered, kpid),
    }).toStrictEqual({
      incarnation: 'incarnation-A',
      state: 'unresolved',
      notified: [],
    });
  });

  it('vat async resolve: the resolution is lost with the aborted crank (gap, #1152)', async () => {
    const harness = await setUp();
    const { kernelStore, vatSyscall, kpid } = harness;
    kernelStore.setPromiseDecider(kpid, 'v2');
    kernelStore.addCListEntry('v2', kpid, 'p+5');
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
      expect(kernelStore.getReachableFlag('v2', target)).toBe(false);
    });
    expect({
      reachable: kernelStore.getReachableFlag('v2', target),
      dropExports: delivered.filter((item) => item.type === 'dropExports'),
    }).toStrictEqual({ reachable: true, dropExports: [] });
  });

  it('lost-vat retirement: the vat stays retired', async () => {
    const harness = await setUp();
    const { kernelStore, failStream } = harness;
    await abortACrankWhile(harness, async () => {
      failStream(new Error('stream died'));
    });
    expect({
      active: kernelStore.isVatActive('v2'),
      terminated: kernelStore.getTerminatedVats().includes('v2'),
    }).toStrictEqual({ active: false, terminated: true });
  });
});
