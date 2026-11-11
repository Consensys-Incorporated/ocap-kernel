import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { delay } from '@metamask/kernel-utils';
import { describe, it, expect, vi } from 'vitest';

import { attempt, KernelQueue } from './KernelQueue.ts';
import { makeKernelStore } from './store/index.ts';
import type { RunQueueItem } from './types.ts';
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
 * Inbox work that records its name as the run loop takes it.
 *
 * @param taken - Where the run loop's items are recorded.
 * @param name - The work's name.
 * @returns The work.
 */
function noting(taken: string[], name: string): () => { value: undefined } {
  return () => {
    taken.push(name);
    return { value: undefined };
  };
}

/**
 * Against a real store and real promise kits, which `KernelQueue.test.ts`
 * mocks.
 */
describe('an inbox item', () => {
  it('is taken ahead of the run queue, in the order asked for', async () => {
    const { kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
      if (taken.length === 1) {
        kernelQueue
          .enqueueInbox('reset', noting(taken, 'reset'))
          .catch(() => undefined);
        kernelQueue
          .enqueueInbox('pin', noting(taken, 'pin'))
          .catch(() => undefined);
        kernelQueue.endRunLoop().catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'reset', 'pin']);
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
      taken.push(item.type);
      if (taken.length === 1) {
        prepare(fixture);
        fixture.kernelQueue
          .enqueueInbox('terminateAllVats', noting(taken, 'terminateAllVats'))
          .catch(() => undefined);
        fixture.kernelQueue.endRunLoop().catch(() => undefined);
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'terminateAllVats']);
  });

  it('answers its caller with the value once its crank has committed', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const order: string[] = [];

    const value = await kernelQueue.enqueueInbox('pin', () => {
      kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'pinned' });
      order.push(`work, in crank: ${kernelStore.isInCrank()}`);
      return { value: 'ko9' };
    });
    order.push(`answered, in crank: ${kernelStore.isInCrank()}`);
    await kernelQueue.endRunLoop();
    await running;

    expect({
      value,
      order,
      written: kernelStore.isVatActive(asVatId('v9')),
    }).toStrictEqual({
      value: 'ko9',
      order: ['work, in crank: true', 'answered, in crank: false'],
      written: true,
    });
  });

  it.each([
    { outcome: 'a failure', abort: false, written: true },
    { outcome: 'a failure that aborts', abort: true, written: false },
  ])(
    'rejects its caller with $outcome, and the run loop goes on',
    async ({ abort, written }) => {
      const { kernelStore, kernelQueue } = await makeFixture(0);
      const running = kernelQueue.run(async () => undefined);
      const failure = new Error('worker would not start');

      await expect(
        kernelQueue.enqueueInbox('launch', () => {
          kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'written' });
          return { abort, failure };
        }),
      ).rejects.toBe(failure);
      await kernelQueue.endRunLoop();
      await running;

      expect({
        written: kernelStore.isVatActive(asVatId('v9')),
        state: kernelQueue.getRunLoopStatus().state,
      }).toStrictEqual({ written, state: 'stopped' });
    },
  );

  it.each([
    { rollback: true, kept: false },
    { rollback: false, kept: true },
  ])(
    'keeps what an attempt wrote before it threw only without a rollback: $rollback',
    async ({ rollback, kept }) => {
      const { kernelStore, kernelQueue } = await makeFixture(0);
      const running = kernelQueue.run(async () => undefined);

      await expect(
        kernelQueue.enqueueInbox('launch', async () =>
          attempt(
            async () => {
              kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'kept' });
              await delay(0);
              throw new Error('worker would not start');
            },
            { rollback },
          ),
        ),
      ).rejects.toThrow('worker would not start');
      await kernelQueue.endRunLoop();
      await running;

      expect(kernelStore.isVatActive(asVatId('v9'))).toBe(kept);
    },
  );

  it('lets the run queue have a crank before an item asked for during another inbox crank', async () => {
    const { kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const ask = (name: string, then: () => void): void => {
      kernelQueue
        .enqueueInbox(name, () => {
          taken.push(name);
          then();
          return { value: undefined };
        })
        .catch(() => undefined);
    };
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
      if (taken.length === 1) {
        ask('first', () =>
          ask('second', () => {
            kernelQueue.endRunLoop().catch(() => undefined);
          }),
        );
      }
      return undefined;
    });

    await running;
    expect(taken).toStrictEqual(['send', 'first', 'send', 'second']);
  });

  it('keeps what it wrote when a later crank aborts', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
      if (taken.length === 1) {
        kernelQueue
          .enqueueInbox('reset', () => {
            taken.push('reset');
            kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'kept' });
            return { value: undefined };
          })
          .catch(() => undefined);
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
    const running = kernelQueue.run(async () => undefined);
    const asked = kernelQueue.enqueueInbox('clearStorage', () => {
      kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'rolled back' });
      throw boom;
    });

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
      let delivered = 0;
      const running = kernelQueue.run(async () => {
        delivered += 1;
        if (delivered === 1) {
          // Taken ahead of the second send, while the first one's crank is open.
          kernelQueue
            .enqueueInbox('reset', () => {
              kernelStore[method]();
              throw boom;
            })
            .catch(() => undefined);
        }
        return undefined;
      });

      await expect(running).rejects.toBe(boom);
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
    const running = kernelQueue.run(async () => undefined);
    running.catch(() => undefined);

    await expect(
      kernelQueue.enqueueInbox('clearStorage', () => {
        armed = true;
        return { value: undefined };
      }),
    ).rejects.toBe(commit);
  });

  it('is rejected with what killed its crank before the work started', async () => {
    const { kdb, kernelQueue } = await makeFixture(0);
    const fault = new Error('SQLITE_FULL');
    const set = kdb.kernelKVStore.set.bind(kdb.kernelKVStore);
    vi.spyOn(kdb.kernelKVStore, 'set').mockImplementation((key, value) => {
      if (key === 'crankNumber') {
        throw fault;
      }
      set(key, value);
    });
    const running = kernelQueue.run(async () => undefined);
    running.catch(() => undefined);

    await expect(
      kernelQueue.enqueueInbox('clearStorage', () => ({ value: undefined })),
    ).rejects.toBe(fault);
  });

  it('is rejected, with any others queued, if the run loop dies first', async () => {
    const { kernelQueue } = await makeFixture(1);
    const taken: string[] = [];
    const queued: Promise<void>[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
      queued.push(
        kernelQueue.enqueueInbox('reset', noting(taken, 'reset')),
        kernelQueue.enqueueInbox('clearStorage', noting(taken, 'clearStorage')),
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

    await expect(
      kernelQueue.enqueueInbox('reset', () => ({ value: undefined })),
    ).rejects.toThrow('Kernel run loop died; cannot reset');
  });

  it.each(['clear', 'reset'] as const)(
    "can run the store's %s inside its crank",
    async (method) => {
      const { kernelStore, kernelQueue } = await makeFixture(2);
      const taken: string[] = [];
      const running = kernelQueue.run(async (item) => {
        taken.push(item.type);
        if (taken.length === 1) {
          kernelQueue
            .enqueueInbox('clearStorage', () => {
              taken.push('clearStorage');
              kernelStore[method]();
              return { value: undefined };
            })
            .catch(() => undefined);
          kernelQueue.endRunLoop().catch(() => undefined);
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

  it('is discarded with the rest queued behind the crank that wipes the store', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const abandoned = new Error('Kernel was reset; queued work was abandoned');
    let later: Promise<void> | undefined;
    const reset = kernelQueue.enqueueInbox('reset', async () => {
      later = kernelQueue.enqueueInbox('terminate a vat', () => {
        kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'late' });
        return { value: undefined };
      });
      await delay(0);
      kernelQueue.discardInbox(abandoned);
      return { value: undefined };
    });

    await reset;
    await expect(later).rejects.toBe(abandoned);
    await kernelQueue.endRunLoop();
    await running;
    expect(kernelStore.isVatActive(asVatId('v9'))).toBe(false);
  });

  it('runs at once before the run loop has started, with no crank to roll back', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);

    const value = await kernelQueue.enqueueInbox('pin', () => {
      kernelStore.setVatConfig(asVatId('v9'), { bundleName: 'at once' });
      return { value: 'ko9' };
    });
    await expect(
      kernelQueue.enqueueInbox('launch', () => ({
        abort: true,
        failure: new Error('worker would not start'),
      })),
    ).rejects.toThrow('worker would not start');

    expect({
      value,
      written: kernelStore.isVatActive(asVatId('v9')),
      inCrank: kernelStore.isInCrank(),
    }).toStrictEqual({
      value: 'ko9',
      written: true,
      inCrank: false,
    });
  });
});

describe('ending the run loop', () => {
  it('takes no crank, and leaves the run queue for the next start', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
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

  it('waits for the inbox items queued before it', async () => {
    const { kernelQueue } = await makeFixture(1);
    const taken: string[] = [];
    const running = kernelQueue.run(async (item) => {
      taken.push(item.type);
      return undefined;
    });
    const asked = kernelQueue.enqueueInbox('reset', noting(taken, 'reset'));

    await kernelQueue.endRunLoop();
    await asked;
    await running;
    expect(taken).toStrictEqual(['send', 'reset']);
  });

  it('refuses a request made during the last crank', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(1);
    let refused: (() => string) | undefined;
    const running = kernelQueue.run(async () => {
      kernelQueue.endRunLoop().catch(() => undefined);
      refused = watch(kernelQueue.enqueueTerminateVat(asVatId('v1')));
      return undefined;
    });

    await running;
    await delay(0);
    expect({
      refused: refused?.(),
      queued: kernelStore.runQueueLength(),
    }).toStrictEqual({
      refused: 'Kernel run loop is stopping; cannot terminate a vat',
      queued: 0,
    });
  });

  it('refuses an inbox item asked for after it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(async () => undefined);
    const ending = kernelQueue.endRunLoop();

    await expect(
      kernelQueue.enqueueInbox('reset', () => ({ value: undefined })),
    ).rejects.toThrow('Kernel run loop is stopping; cannot reset');
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
    await expect(
      kernelQueue.enqueueInbox('reset', () => ({ value: undefined })),
    ).rejects.toThrow('Kernel run loop is stopped; cannot reset');
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
