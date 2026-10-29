import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { makeKernelStore } from './store/index.ts';
import type { RunLoopItem, RunQueueItem } from './types.ts';
import { makeGCAction } from './types.ts';
import { asRRef, asRemoteId, asVatId } from '../test/branded.ts';
import { watch } from '../test/real-kernel.ts';

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

type Fixture = Awaited<ReturnType<typeof makeFixture>>;

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
        kernelQueue.enqueueControl('terminateAllVats').catch(() => undefined);
        kernelQueue.endRunLoop().catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'reset', 'terminateAllVats']);
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
        fixture.kernelQueue
          .enqueueControl('terminateAllVats')
          .catch(() => undefined);
        fixture.kernelQueue.endRunLoop().catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'terminateAllVats']);
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
        kernelQueue.endRunLoop().catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect({
      taken,
      written: kernelStore.isVatActive(asVatId('v9')),
    }).toStrictEqual({
      taken: ['send', 'reset', 'send', 'send'],
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

  it('is rejected with what failed its commit', async () => {
    const { kdb, kernelQueue } = await makeFixture(0);
    const commit = new Error('RELEASE failed');
    let armed = false;
    const release = kdb.releaseSavepoint.bind(kdb);
    vi.spyOn(kdb, 'releaseSavepoint').mockImplementation((name) => {
      if (armed) {
        armed = false;
        throw commit;
      }
      release(name);
    });
    const running = kernelQueue.run(async (item) => {
      armed = item.type === 'control';
      return undefined;
    });
    running.catch(() => undefined);

    await expect(kernelQueue.enqueueControl('clearStorage')).rejects.toBe(
      commit,
    );
  });

  it('is rejected, with any others queued, if the run loop dies first', async () => {
    const { kernelQueue } = await makeFixture(1);
    const taken: string[] = [];
    const queued: Promise<void>[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      queued.push(
        kernelQueue.enqueueControl('reset'),
        kernelQueue.enqueueControl('clearStorage'),
      );
      throw new Error('loop dies');
    });

    await expect(running).rejects.toThrow('loop dies');
    const outcomes = await Promise.allSettled(queued);
    expect({
      taken,
      outcomes: outcomes.map((outcome) =>
        outcome.status === 'rejected'
          ? (outcome.reason as Error).message
          : outcome.status,
      ),
    }).toStrictEqual({
      taken: ['send'],
      outcomes: [
        'Kernel run loop died; this work will never be carried out',
        'Kernel run loop died; this work will never be carried out',
      ],
    });
  });

  it('is refused once the run loop has died', async () => {
    const { kernelQueue } = await makeFixture(1);
    await expect(
      kernelQueue.run(async () => {
        throw new Error('loop dies');
      }),
    ).rejects.toThrow('loop dies');

    await expect(kernelQueue.enqueueControl('reset')).rejects.toThrow(
      'Kernel run loop died; cannot reset',
    );
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
          kernelQueue.endRunLoop().catch(() => undefined);
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
        taken: ['send', 'clearStorage'],
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

describe('ending the run loop', () => {
  it('takes no crank, and leaves the run queue for the next start', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      return undefined;
    });

    await kernelQueue.endRunLoop();
    await running;
    expect({
      taken,
      queued: kernelStore.runQueueLength(),
      state: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({
      taken: ['send'],
      queued: 1,
      state: 'stopped',
    });
  });

  it('settles every caller asking for it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const first = watch(kernelQueue.endRunLoop());
    const second = watch(kernelQueue.endRunLoop());

    await running;
    await delay(0);
    expect([first(), second()]).toStrictEqual(['fulfilled', 'fulfilled']);
  });

  it('waits for the control operations queued before it', async () => {
    const { kernelQueue } = await makeFixture(1);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(nameOf(item));
      return undefined;
    });
    const asked = kernelQueue.enqueueControl('reset');

    await kernelQueue.endRunLoop();
    await asked;
    await running;
    expect(taken).toStrictEqual(['send', 'reset']);
  });

  it('writes a request made during the last crank, for the next start', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(1);
    const running = kernelQueue.run(async () => {
      kernelQueue.endRunLoop().catch(() => undefined);
      kernelQueue.enqueueTerminateVat(asVatId('v1'));
      return undefined;
    });

    await running;
    expect(kernelStore.dequeueRun()).toStrictEqual({
      type: 'terminateVat',
      vatId: 'v1',
    });
  });

  it('writes at once a request made during the afterCommit of the last crank', async () => {
    const { kernelQueue } = await makeFixture(1);
    let written: (() => string) | undefined;
    const running = kernelQueue.run(async () => {
      kernelQueue.endRunLoop().catch(() => undefined);
      return {
        afterCommit: async () => {
          written = watch(kernelQueue.writeOutsideCrank(() => 'written'));
          await delay(0);
        },
      };
    });

    await running;
    await delay(0);
    expect({
      written: written?.(),
      state: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({ written: 'fulfilled', state: 'stopped' });
  });

  it('refuses a control operation asked for after it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const ending = kernelQueue.endRunLoop();

    await expect(kernelQueue.enqueueControl('reset')).rejects.toThrow(
      'Kernel run loop is stopping; cannot reset',
    );
    await ending;
    await running;
  });

  it('refuses work from then on', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    await kernelQueue.endRunLoop();
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

  it('is done once the run loop dies first', async () => {
    const { kernelQueue } = await makeFixture(1);
    let ending: Promise<void> | undefined;
    const running = kernelQueue.run(async () => {
      ending = kernelQueue.endRunLoop();
      throw new Error('loop dies');
    });

    await expect(running).rejects.toThrow('loop dies');
    await ending;
    expect(kernelQueue.getRunLoopStatus().state).toBe('failed');
  });

  it('is done at once on a run loop that has died', async () => {
    const { kernelQueue } = await makeFixture(1);
    await expect(
      kernelQueue.run(async () => {
        throw new Error('loop dies');
      }),
    ).rejects.toThrow('loop dies');

    expect(await kernelQueue.endRunLoop()).toBeUndefined();
  });

  it('is refused before the run loop has started', async () => {
    const { kernelQueue } = await makeFixture(0);

    await expect(kernelQueue.endRunLoop()).rejects.toThrow(
      'run loop has not started',
    );
  });
});

describe('the run loop', () => {
  it('refuses a savepoint taken alongside a crank', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);

    expect(() => kernelStore.createSavepoint('mine')).toThrow(
      'while the run loop is running',
    );
    await kernelQueue.endRunLoop();
    await running;
  });

  it.each([
    {
      ended: 'is ended',
      end: async (kernelQueue: KernelQueue): Promise<void> => {
        const running = kernelQueue.run(async () => undefined);
        await kernelQueue.endRunLoop();
        await running;
      },
    },
    {
      ended: 'dies',
      end: async (kernelQueue: KernelQueue): Promise<void> => {
        kernelQueue.enqueueTerminateVat(asVatId('v1'));
        await kernelQueue
          .run(async () => {
            throw new Error('boom');
          })
          .catch(() => undefined);
      },
    },
  ])('allows a savepoint once it $ended', async ({ end }) => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    await end(kernelQueue);

    expect(() => {
      kernelStore.createSavepoint('mine');
      kernelStore.releaseSavepoint('mine');
    }).not.toThrow();
  });

  it('cannot run again once it has been ended', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    await kernelQueue.endRunLoop();
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
