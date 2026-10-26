import { makePromiseKit } from '@endo/promise-kit';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { makeKernelStore } from './store/index.ts';
import type { RunLoopItem, RunQueueItem } from './types.ts';
import { makeGCAction } from './types.ts';
import { asRRef, asRemoteId, asVatId } from '../test/branded.ts';

const arrival = {
  remoteId: asRemoteId('r1'),
  peerId: 'peer-1',
  seq: 1,
  message: '{"seq":1}',
  highestReceivedSeq: 0,
};

/**
 * A queue over a real store, with a run queue holding `items` sends.
 *
 * @param items - How many items to queue.
 * @returns The database, its store and the queue.
 */
type Fixture = Awaited<ReturnType<typeof makeFixture>>;

async function makeFixture(items: number): Promise<{
  kdb: Awaited<ReturnType<typeof makeSQLKernelDatabase>>;
  kernelStore: ReturnType<typeof makeKernelStore>;
  kernelQueue: KernelQueue;
}> {
  const kdb = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
  const kernelStore = makeKernelStore(kdb);
  kernelStore.initEndpoint(asVatId('v1'));
  for (let queued = 0; queued < items; queued += 1) {
    kernelStore.enqueueRun({
      type: 'send',
      target: kernelStore.initKernelObject(asVatId('v1')),
      message: { methargs: { body: '', slots: [] }, result: null },
    } as unknown as RunQueueItem);
  }
  return {
    kdb,
    kernelStore,
    kernelQueue: new KernelQueue(kernelStore, async () => undefined),
  };
}

/**
 * @param item - An item the run loop took.
 * @returns Its operation if it is a control operation, else its type.
 */
function nameOf(item: RunLoopItem): string {
  return item.type === 'control' ? item.operation : item.type;
}

/**
 * Against a real store and real promise kits, which `KernelQueue.test.ts`
 * mocks.
 */
describe('a control operation', () => {
  it('is taken ahead of the run queue, in the order asked for', async () => {
    const { kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      if (taken.length === 1) {
        kernelQueue.enqueueControl('reset').catch(() => undefined);
        kernelQueue.enqueueControl('stop').catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'reset', 'stop']);
  });

  it.each([
    {
      waiting: 'peer arrival',
      prepare: ({ kernelQueue }: Fixture): void => {
        kernelQueue.acceptRemoteInbound(arrival);
      },
    },
    {
      waiting: 'GC action',
      prepare: ({ kernelStore }: Fixture): void => {
        const remoteId = asRemoteId('r1');
        kernelStore.initEndpoint(remoteId);
        const kref = kernelStore.initKernelObject(asVatId('v1'));
        kernelStore.addCListEntry(remoteId, kref, asRRef('ro-1'));
        kernelStore.addGCActions([
          makeGCAction(remoteId, 'retireImport', kref),
        ]);
      },
    },
    {
      waiting: 'reap',
      prepare: ({ kernelStore }: Fixture): void => {
        kernelStore.scheduleReap(asVatId('v1'));
      },
    },
  ])('is taken ahead of a waiting $waiting', async ({ prepare }) => {
    const fixture = await makeFixture(1);
    const taken: string[] = [];
    const running = fixture.kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      if (taken.length === 1) {
        prepare(fixture);
        fixture.kernelQueue.enqueueControl('stop').catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'stop']);
  });

  it('keeps what it wrote when a later crank aborts', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      if (taken.length === 1) {
        kernelQueue.enqueueControl('reset').catch(() => undefined);
      } else if (item.type === 'control' && item.operation === 'reset') {
        kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'kept' });
      } else if (taken.length === 3) {
        return { abort: true };
      } else if (taken.length === 4) {
        kernelQueue.enqueueControl('stop').catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect({
      taken,
      written: kernelStore.isVatActive(asVatId('v9')),
    }).toStrictEqual({
      taken: ['send', 'reset', 'send', 'send', 'stop'],
      written: true,
    });
  });

  it('rolls back what it wrote if it throws, and kills the run loop', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const boom = new Error('wipe failed');
    const running = kernelQueue.run(async (item) => {
      if (item.type === 'control') {
        kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'rolled back' });
        throw boom;
      }
      return undefined;
    });
    const asked = kernelQueue.enqueueControl('clearStorage');

    await expect(running).rejects.toBe(boom);
    await expect(asked).rejects.toBe(boom);
    expect({
      written: kernelStore.isVatActive(asVatId('v9')),
      state: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({ written: false, state: 'failed' });
  });

  it.each(['clear', 'reset'] as const)(
    "rolls back the store's %s, caches included, if it throws after it",
    async (method) => {
      const { kdb, kernelStore, kernelQueue } = await makeFixture(2);
      kernelStore.setVatConfig(asVatId('v1'), { bundleName: 'before' });
      const boom = new Error('failed after the wipe');
      const running = kernelQueue.run(async (item) => {
        if (item.type === 'control') {
          kernelStore[method]();
          throw boom;
        }
        return undefined;
      });
      // Taken ahead of the second send, while the first one's crank is open.
      const asked = kernelQueue.enqueueControl('reset');

      await expect(running).rejects.toBe(boom);
      await expect(asked).rejects.toBe(boom);
      const reopened = makeKernelStore(kdb);
      expect({
        cachedQueueLength: kernelStore.runQueueLength(),
        persistedQueueLength: reopened.runQueueLength(),
        config: reopened.getVatConfig(asVatId('v1')),
      }).toStrictEqual({
        cachedQueueLength: 1,
        persistedQueueLength: 1,
        config: { bundleName: 'before' },
      });
    },
  );

  it('is answered once its crank commits, even if a held write then kills the run loop', async () => {
    const { kdb, kernelStore, kernelQueue } = await makeFixture(0);
    const target = kernelStore.initKernelObject(asVatId('v1'));
    const full = new Error('SQLITE_FULL');
    let armed = false;
    const set = kdb.kernelKVStore.set.bind(kdb.kernelKVStore);
    // Fails the held message's write, which creates its result promise.
    vi.spyOn(kdb.kernelKVStore, 'set').mockImplementation((key, value) => {
      if (armed && key.endsWith('.state') && value === 'unresolved') {
        throw full;
      }
      set(key, value);
    });
    let message: Promise<unknown> | undefined;
    const running = kernelQueue.run(async (item) => {
      if (item.type === 'control') {
        message = kernelQueue.enqueueMessage(target, 'held', []);
        message.catch(() => undefined);
        armed = true;
      }
      return undefined;
    });

    await kernelQueue.enqueueControl('terminateAllVats');
    await expect(running).rejects.toBe(full);
    await expect(message).rejects.toThrow('Kernel run loop died');
  });

  it('is carried out with no crank, in order, once the run loop has died', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const firstDone = makePromiseKit<void>();
    const carriedOut: string[] = [];
    const running = kernelQueue.run(async (item) => {
      if (item.type !== 'control') {
        return undefined;
      }
      if (item.operation === 'clearStorage') {
        throw new Error('wipe failed');
      }
      carriedOut.push(
        `${item.operation} ${kernelStore.isInCrank() ? 'in' : 'outside'} a crank`,
      );
      if (item.operation === 'reset') {
        await firstDone.promise;
      }
      return undefined;
    });
    kernelQueue.enqueueControl('clearStorage').catch(() => undefined);
    const queuedBehind = kernelQueue.enqueueControl('reset');
    await expect(running).rejects.toThrow('wipe failed');

    const askedAfter = kernelQueue.enqueueControl('terminateAllVats');
    await delay(0);
    const beforeFirstDone = [...carriedOut];
    firstDone.resolve();
    await Promise.all([queuedBehind, askedAfter]);

    expect({ beforeFirstDone, carriedOut }).toStrictEqual({
      beforeFirstDone: ['reset outside a crank'],
      carriedOut: ['reset outside a crank', 'terminateAllVats outside a crank'],
    });
  });

  it.each(['clear', 'reset'] as const)(
    "can run the store's %s inside its crank",
    async (method) => {
      const { kernelStore, kernelQueue } = await makeFixture(2);
      const taken: string[] = [];
      const running = kernelQueue.run(async (item) => {
        taken.push(nameOf(item));
        if (taken.length === 1) {
          kernelQueue.enqueueControl('clearStorage').catch(() => undefined);
          kernelQueue.enqueueControl('stop').catch(() => undefined);
        } else if (
          item.type === 'control' &&
          item.operation === 'clearStorage'
        ) {
          kernelStore[method]();
        }
        return undefined;
      });

      await running;
      expect({
        taken,
        queued: kernelStore.runQueueLength(),
        state: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({
        taken: ['send', 'clearStorage', 'stop'],
        queued: 0,
        state: 'stopped',
      });
    },
  );

  it('is refused before the run loop has started', async () => {
    const { kernelQueue } = await makeFixture(0);

    await expect(kernelQueue.enqueueControl('reset')).rejects.toThrow(
      'run loop has not started',
    );
  });
});

describe('a stop', () => {
  it('ends the run loop, leaving the run queue for the next start', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      return undefined;
    });

    await kernelQueue.enqueueControl('stop');
    await running;
    expect({
      taken,
      queued: kernelStore.runQueueLength(),
      state: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({
      taken: ['send', 'stop'],
      queued: 1,
      state: 'stopped',
    });
  });

  it('writes a request made during its crank, for the next start', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async (item) => {
      if (item.type === 'control') {
        kernelQueue.enqueueTerminateVat(asVatId('v1'));
      }
      return undefined;
    });

    await kernelQueue.enqueueControl('stop');
    await running;
    expect(kernelStore.dequeueRun()).toStrictEqual({
      type: 'terminateVat',
      vatId: 'v1',
    });
  });

  it('rejects the control operations queued behind it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const stopped = kernelQueue.enqueueControl('stop');
    const queuedBehind = kernelQueue.enqueueControl('reset');

    await stopped;
    await running;
    await expect(queuedBehind).rejects.toThrow(
      'Kernel run loop stopped before reset ran',
    );
  });

  it('refuses work from then on', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    await kernelQueue.enqueueControl('stop');
    await running;

    expect(() => kernelQueue.assertRunLoopAlive('queue a message')).toThrow(
      'Kernel run loop is stopped; cannot queue a message',
    );
    expect(() => kernelQueue.acceptRemoteInbound(arrival)).toThrow(
      'Kernel run loop is stopped',
    );
    await expect(kernelQueue.writeOutsideCrank(vi.fn())).rejects.toThrow(
      'Kernel run loop is stopped',
    );
    await expect(kernelQueue.enqueueControl('reset')).rejects.toThrow(
      'Kernel run loop is stopped; cannot reset',
    );
  });
});

describe('the run loop', () => {
  it('cannot run again once a stop has ended it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    await kernelQueue.enqueueControl('stop');
    await running;

    await expect(kernelQueue.run(async () => undefined)).rejects.toThrow(
      'run loop already started',
    );
    expect(kernelQueue.getRunLoopStatus().state).toBe('stopped');
  });

  it('cannot run again once it has died', async () => {
    const { kernelQueue } = await makeFixture(1);
    await expect(
      kernelQueue.run(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(kernelQueue.run(async () => undefined)).rejects.toThrow(
      'run loop already started',
    );
    expect(kernelQueue.getRunLoopStatus().state).toBe('failed');
  });
});
