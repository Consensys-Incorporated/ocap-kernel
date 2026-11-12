import type { CapData } from '@endo/marshal';
import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { KernelRouter } from './KernelRouter.ts';
import {
  kser,
  kslot,
  makeFatalKernelError,
  makeKernelError,
} from './liveslots/kernel-marshal.ts';
import { makeKernelStore } from './store/index.ts';
import type {
  CrankResult,
  EndpointHandle,
  KRef,
  Message,
  VatId,
} from './types.ts';
import { asVatId, asVRef } from '../test/branded.ts';

/**
 * What `v1` does with one delivered message. It may resolve the result (inside
 * the crank), and returns the crank's outcome.
 */
type OnDeliver = (context: {
  kpid: KRef;
  attempt: number;
  resolve: (rejected: boolean, value: CapData<KRef>) => void;
  exportPromise: (vref: string) => KRef;
}) => CrankResult | undefined;

/**
 * A real store, queue, router and run loop over vat `v1`, with the refcount
 * audit on every crank. `v1` retires its c-list entry for a promise it
 * resolves, as on #1229, so the hold is the only thing keeping a settled
 * result alive. `kdb` can be passed to restart on the same database.
 *
 * @param options - Options bag.
 * @param options.onDeliver - How `v1` handles each message.
 * @param options.kdb - An existing database, to restart a kernel on.
 * @returns The pieces a test drives.
 */
async function setUp({
  onDeliver,
  kdb: existingKdb,
}: {
  onDeliver: OnDeliver;
  kdb?: KernelDatabase;
}) {
  const kdb =
    existingKdb ?? (await makeSQLKernelDatabase({ dbFilename: ':memory:' }));
  const kernelStore = makeKernelStore(kdb);
  kernelStore.setRefCountAuditing(true);
  const v1 = asVatId('v1');
  let root: KRef;
  let gift: KRef;
  if (existingKdb) {
    root = kernelStore.erefToKref(v1, asVRef('o+0')) as KRef;
    gift = kernelStore.erefToKref(v1, asVRef('o+1')) as KRef;
  } else {
    kernelStore.setVatConfig(v1, { bundleName: 'vat1' });
    kernelStore.initEndpoint(v1);
    root = kernelStore.exportFromEndpoint(v1, asVRef('o+0'));
    kernelStore.pinObject(root);
    gift = kernelStore.exportFromEndpoint(v1, asVRef('o+1'));
  }

  const terminateVat = async (vatId: VatId): Promise<void> => {
    kernelStore.markVatAsTerminated(vatId);
    for (const kpid of [...kernelStore.getPromisesByDecider(vatId)]) {
      kernelQueue.resolvePromises(vatId, [
        [kpid, true, makeKernelError('VAT_TERMINATED', 'gone')],
      ]);
    }
  };
  const kernelQueue = new KernelQueue(kernelStore, terminateVat);
  let attempt = 0;
  const deliveries: string[] = [];
  const endpoint = {
    deliverMessage: vi.fn(async (_target, message: Message) => {
      attempt += 1;
      const kpid = kernelStore.erefToKref(v1, message.result as string) as KRef;
      return onDeliver({
        kpid,
        attempt,
        resolve: (rejected, value) => {
          kernelQueue.resolvePromises(v1, [[kpid, rejected, value]], false);
          kernelStore.forgetKref(v1, kpid);
        },
        exportPromise: (vref) => kernelStore.translateRefEtoK(v1, asVRef(vref)),
      });
    }),
    deliverNotify: vi.fn().mockResolvedValue({}),
    deliverDropExports: vi.fn(async (vrefs: string[]) => {
      deliveries.push(`dropExports ${vrefs.join(',')}`);
      return {};
    }),
    deliverRetireExports: vi.fn(async (vrefs: string[]) => {
      deliveries.push(`retireExports ${vrefs.join(',')}`);
      return {};
    }),
    deliverRetireImports: vi.fn().mockResolvedValue({}),
    deliverBringOutYourDead: vi.fn().mockResolvedValue({}),
  } as unknown as EndpointHandle;
  const kernelRouter = new KernelRouter({
    kernelStore,
    kernelQueue,
    getEndpoint: (endpointId) => {
      if (kernelStore.isVatTerminated(endpointId as VatId)) {
        throw new Error(`${endpointId} is terminated`);
      }
      return endpoint;
    },
    invokeKernelService: () => undefined,
    restartVat: async () => undefined,
    terminateVat,
    applyIncarnationChange: () => ({}),
    performControl: async () => undefined,
    logger: { error: vi.fn(), log: vi.fn() } as unknown as Logger,
  });
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);

  let running: Promise<void> | undefined;
  const start = (): void => {
    running = kernelQueue.run(kernelRouter.deliver.bind(kernelRouter));
  };
  const stop = async (): Promise<void> => {
    await kernelQueue.endRunLoop();
    await running;
  };
  // Until the run queue and the GC actions are empty.
  const settle = async (label = ''): Promise<void> => {
    for (let tries = 0; tries < 100; tries += 1) {
      await delay(5);
      await kernelQueue.waitForCrank();
      if (
        kernelStore.runQueueLength() === 0 &&
        kernelStore.getGCActions().size === 0
      ) {
        return;
      }
    }
    throw new Error(
      `did not settle at ${label}: runQueue ${kernelStore.runQueueLength()}, gcActions ${[...kernelStore.getGCActions()].join(' ')}`,
    );
  };
  const dump = (): Record<string, string> => {
    const rows: Record<string, string> = {};
    for (const { key, value } of kdb.executeQuery(
      'SELECT key, value FROM kv',
    ) as { key: string; value: string }[]) {
      rows[key] = value;
    }
    return rows;
  };

  return {
    kdb,
    kernelStore,
    kernelQueue,
    root,
    gift,
    start,
    stop,
    settle,
    dump,
    deliveries,
    running: () => running,
    v1,
  };
}

const answerWithGift: OnDeliver = ({ resolve }) => {
  resolve(false, kser(kslot(GIFT)));
  return {};
};
// Filled in per test; `v1`'s gift is always `ko2` in a fresh store.
const GIFT = 'ko2' as KRef;

describe('the hold on a queueMessage result, adversarially', () => {
  describe('1. a delivery that resolves a held result and then aborts', () => {
    it.each([
      ['an answer with slots both times', true, true],
      ['an answer with slots, then data on the retry', true, false],
      ['data, then an answer with slots on the retry', false, true],
    ])(
      'leaves the hold, the refcounts and the answer consistent: %s',
      async (_title, slotsFirst, slotsOnRetry) => {
        const { kernelStore, kernelQueue, root, gift, start, stop, settle } =
          await setUp({
            onDeliver: ({ resolve, attempt }) => {
              const withSlots = attempt === 1 ? slotsFirst : slotsOnRetry;
              resolve(false, withSlots ? kser(kslot(GIFT)) : kser('data'));
              return attempt === 1 ? { abort: true } : {};
            },
          });
        expect(gift).toBe(GIFT);
        start();

        const result = await kernelQueue.enqueueMessage(root, 'fetch', []);
        await settle('s1');

        const held = kernelStore.getHeldResults();
        expect({
          answer: result,
          held,
          audit: kernelStore.auditRefCounts(),
        }).toStrictEqual({
          answer: slotsOnRetry
            ? { ...kser(kslot(gift)), kpid: held[0] }
            : kser('data'),
          held: slotsOnRetry ? [expect.any(String)] : [],
          audit: [],
        });
        if (slotsOnRetry) {
          expect(kernelStore.getObjectRefCount(gift).reachable).toBe(1);
          await kernelQueue.releaseResult(result.kpid as KRef);
          await settle('s2');
          expect(kernelStore.kernelRefExists(result.kpid as KRef)).toBe(false);
          expect(kernelStore.auditRefCounts()).toStrictEqual([]);
        }
        await stop();
      },
    );
  });

  describe('2. a vat terminated mid-delivery', () => {
    it('rejects the caller and releases the hold, leaving no row behind', async () => {
      const { kernelStore, kernelQueue, root, start, stop, settle } =
        await setUp({
          onDeliver: ({ resolve }) => {
            resolve(false, kser(kslot(GIFT)));
            return {
              didDelivery: asVatId('v1'),
              abort: true,
              terminate: {
                vatId: asVatId('v1'),
                reject: true,
                info: makeFatalKernelError('INTERNAL_ERROR', 'died'),
              },
            };
          },
        });
      start();

      const answered = kernelQueue.enqueueMessage(root, 'fetch', []);
      await expect(answered).rejects.toBeDefined();
      await settle('s3');

      expect({
        held: kernelStore.getHeldResults(),
        audit: kernelStore.auditRefCounts(),
      }).toStrictEqual({ held: [], audit: [] });
      await stop();
    });
  });

  describe('3. a restart with an unsettled held result', () => {
    it('releases the hold at boot and settles the late answer cleanly', async () => {
      const first = await setUp({ onDeliver: () => ({}) });
      first.start();
      // Never answered by this kernel.
      const orphan = first.kernelQueue.enqueueMessage(first.root, 'fetch', []);
      orphan.catch(() => undefined);
      await first.settle('s4');
      const [kpid] = first.kernelStore.getHeldResults();
      expect(kpid).toBeDefined();
      await first.stop();

      const second = await setUp({
        onDeliver: ({ resolve }) => {
          resolve(false, kser('pong'));
          return {};
        },
        kdb: first.kdb,
      });
      expect(second.kernelQueue.releaseAbandonedResults()).toBe(1);
      expect({
        held: second.kernelStore.getHeldResults(),
        audit: second.kernelStore.auditRefCounts(),
        state: second.kernelStore.getKernelPromise(kpid as KRef).state,
      }).toStrictEqual({ held: [], audit: [], state: 'unresolved' });
      second.start();

      // v1 answers late, from outside any crank, as VatSyscall does then.
      expect(() =>
        second.kernelQueue.resolvePromises(second.v1, [
          [kpid as KRef, false, kser(kslot(second.gift))],
        ]),
      ).not.toThrow();
      await second.kernelQueue.writeOutsideCrank(() =>
        second.kernelStore.forgetKref(second.v1, kpid as KRef),
      );
      // Any later crank collects what the retirement freed.
      expect(
        await second.kernelQueue.enqueueMessage(second.root, 'ping', []),
      ).toStrictEqual(kser('pong'));
      await second.settle('s5');

      expect({
        held: second.kernelStore.getHeldResults(),
        audit: second.kernelStore.auditRefCounts(),
        promiseExists: second.kernelStore.kernelRefExists(kpid as KRef),
        giftExists: second.kernelStore.kernelRefExists(second.gift),
      }).toStrictEqual({
        held: [],
        audit: [],
        promiseExists: false,
        giftExists: false,
      });
      await second.stop();
    });
  });

  describe('5. a release outside a crank', () => {
    it('deletes the promise and collects its slots without another message', async () => {
      const {
        kernelStore,
        kernelQueue,
        root,
        gift,
        start,
        stop,
        settle,
        deliveries,
      } = await setUp({ onDeliver: answerWithGift });
      start();
      const result = await kernelQueue.enqueueMessage(root, 'fetch', []);
      await settle('s6');
      const runQueueBefore = kernelStore.runQueueLength();

      await kernelQueue.releaseResult(result.kpid as KRef);
      await settle('s7');

      expect({
        runQueueBefore,
        promiseExists: kernelStore.kernelRefExists(result.kpid as KRef),
        giftExists: kernelStore.kernelRefExists(gift),
        gcActions: [...kernelStore.getGCActions()],
        audit: kernelStore.auditRefCounts(),
        deliveries,
      }).toStrictEqual({
        runQueueBefore: 0,
        promiseExists: false,
        giftExists: false,
        gcActions: [],
        audit: [],
        deliveries: ['dropExports o+1', 'retireExports o+1'],
      });
      await stop();
    });

    it('leaves nothing at refCount 0 after a restart that follows the release', async () => {
      const first = await setUp({ onDeliver: answerWithGift });
      first.start();
      const result = await first.kernelQueue.enqueueMessage(
        first.root,
        'fetch',
        [],
      );
      await first.settle('s8');
      // Stop the run loop first, so the GC actions are left for the restart.
      await first.stop();
      first.kernelStore.releaseHeldResult(result.kpid as KRef);
      first.kernelStore.collectGarbage();

      const second = await setUp({ onDeliver: answerWithGift, kdb: first.kdb });
      second.kernelQueue.releaseAbandonedResults();
      second.start();
      await second.settle('s9');

      const zeroCounted = Object.entries(second.dump()).filter(
        ([key, value]) =>
          /^k[op]\d+\.refCount$/u.test(key) && /^0(,0)?$/u.test(value),
      );
      expect({
        zeroCounted,
        giftExists: second.kernelStore.kernelRefExists(second.gift),
        audit: second.kernelStore.auditRefCounts(),
      }).toStrictEqual({ zeroCounted: [], giftExists: false, audit: [] });
      await second.stop();
    });
  });

  describe('6. double release and forged kpids', () => {
    it.each([
      ['a released kpid', 'released'],
      ['an unheld unresolved promise', 'unheld'],
      ['an object kref', 'ko1'],
      ['a kpid that never existed', 'kp999'],
    ])('throws and changes nothing for %s', async (_title, which) => {
      const { kernelStore, kernelQueue, root, start, stop, settle, dump } =
        await setUp({ onDeliver: answerWithGift });
      start();
      const result = await kernelQueue.enqueueMessage(root, 'fetch', []);
      await kernelQueue.releaseResult(result.kpid as KRef);
      // A promise nothing holds, made between cranks so the audit agrees.
      const unheld = await kernelQueue.writeOutsideCrank(
        () => kernelStore.initKernelPromise()[0],
      );
      await settle('s10');
      const kpid =
        ({ released: result.kpid, unheld } as Record<string, KRef | undefined>)[
          which
        ] ?? (which as KRef);
      const before = dump();

      await expect(kernelQueue.releaseResult(kpid)).rejects.toThrow(
        'is not a held result',
      );
      await settle('s11');

      expect(dump()).toStrictEqual(before);
      await stop();
    });
  });

  describe('6b. a kpid named by someone other than its caller', () => {
    it('does not let one caller end the hold another caller was given', async () => {
      const { kernelStore, kernelQueue, root, gift, start, stop, settle } =
        await setUp({ onDeliver: answerWithGift });
      start();
      const first = await kernelQueue.enqueueMessage(root, 'fetch', []);
      await settle('s6b');

      // A second caller guesses the first caller's kpid, a sequential string.
      const guessed = `kp${Number((first.kpid as string).slice(2))}` as KRef;
      const forged = await kernelQueue.releaseResult(guessed).then(
        () => 'accepted',
        () => 'refused',
      );
      await settle('s6c');

      expect({
        forged,
        giftStillCounted: kernelStore.kernelRefExists(gift),
      }).toStrictEqual({ forged: 'refused', giftStillCounted: true });
      await stop();
    });
  });

  describe('7. an answer whose slots include an unresolved promise', () => {
    it('keeps the promise until release, and lets it be collected after', async () => {
      let inner: KRef | undefined;
      const { kernelStore, kernelQueue, root, v1, start, stop, settle } =
        await setUp({
          onDeliver: ({ resolve, exportPromise }) => {
            inner = exportPromise('p+7');
            resolve(false, kser([kslot(inner)]));
            return {};
          },
        });
      start();
      const result = await kernelQueue.enqueueMessage(root, 'fetch', []);
      await settle('s12');
      const innerKpid = inner as KRef;
      expect(result.slots).toStrictEqual([innerKpid]);

      // v1 settles and retires the inner promise; the held result still names it.
      await kernelQueue.writeOutsideCrank(() => {
        kernelQueue.resolvePromises(v1, [[innerKpid, false, kser('late')]]);
        kernelStore.forgetKref(v1, innerKpid);
      });
      kernelStore.collectGarbage();
      await settle('s13');
      const keptUntilRelease = kernelStore.kernelRefExists(innerKpid);

      await kernelQueue.releaseResult(result.kpid as KRef);
      await settle('s14');

      expect({
        keptUntilRelease,
        collectedAfter: !kernelStore.kernelRefExists(innerKpid),
        audit: kernelStore.auditRefCounts(),
      }).toStrictEqual({
        keptUntilRelease: true,
        collectedAfter: true,
        audit: [],
      });
      await stop();
    });
  });
});
