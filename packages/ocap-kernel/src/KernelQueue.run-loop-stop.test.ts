import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { describe, it, expect, vi } from 'vitest';

import { KernelQueue } from './KernelQueue.ts';
import { makeKernelStore } from './store/index.ts';
import type { RunQueueItem } from './types.ts';
import { asRemoteId, asVatId } from '../test/branded.ts';

const arrival = {
  remoteId: asRemoteId('r1'),
  peerId: 'peer-1',
  seq: 1,
  message: '{"seq":1}',
  highestReceivedSeq: 0,
};

/**
 * Against a real store and real promise kits, which `KernelQueue.test.ts`
 * mocks.
 */
describe('the window a stopped run loop opens', () => {
  /**
   * A queue over a real store, with a run queue holding `items` sends.
   *
   * @param items - How many items to queue.
   * @returns The store and its queue.
   */
  async function makeFixture(items: number): Promise<{
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
      kernelStore,
      kernelQueue: new KernelQueue(kernelStore, async () => undefined),
    };
  }

  it('has no crank open when the caller gets control back', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      // Asked from inside a delivery, so a crank is open at the moment of
      // asking and the loop has to finish it first.
      stopped ??= kernelQueue.stopRunLoop();
      return undefined;
    });

    expect(await stopped).toBe(true);
    expect(kernelStore.isInCrank()).toBe(false);
    await running;
  });

  it('keeps a write made in it out of the next crank', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(2);
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      stopped ??= kernelQueue.stopRunLoop();
      return undefined;
    });
    await stopped;
    await running;

    kernelStore.setVatConfig(asVatId('v9'), {
      bundleName: 'written-between-cranks',
    });

    const abortingRun = kernelQueue.run(async () => ({ abort: true }));
    await kernelQueue.stopRunLoop();
    await abortingRun;

    expect(kernelStore.getVatConfig(asVatId('v9'))).toStrictEqual({
      bundleName: 'written-between-cranks',
    });
  });

  it('lets go of a caller waiting on a loop that died instead', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(1);
    const boom = new Error('crank exploded');
    let stopped: Promise<boolean> | undefined;
    const running = kernelQueue.run(async () => {
      stopped ??= kernelQueue.stopRunLoop();
      throw boom;
    });

    await expect(running).rejects.toBe(boom);

    expect(await stopped).toBe(false);
    expect(kernelStore.isInCrank()).toBe(false);
  });

  it('answers every caller that asked it to stop', async () => {
    const { kernelQueue } = await makeFixture(2);
    const asks: Promise<boolean>[] = [];
    const running = kernelQueue.run(async () => {
      if (asks.length === 0) {
        asks.push(kernelQueue.stopRunLoop(), kernelQueue.stopRunLoop());
      }
      return undefined;
    });

    expect(await Promise.all(asks)).toStrictEqual([true, true]);
    await running;
  });

  it('refuses a host call while it is stopped', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    expect(() => kernelQueue.assertRunLoopAlive('queue a message')).toThrow(
      'Kernel run loop is stopped',
    );
  });

  it('takes a peer arrival made while it is stopped once it runs again', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    expect(kernelQueue.acceptRemoteInbound(arrival)).toBe(true);
    const deliver = vi.fn(async () => undefined);
    const rerun = kernelQueue.run(deliver);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    await kernelQueue.stopRunLoop();
    await rerun;

    expect(deliver).toHaveBeenCalledWith({
      type: 'remoteInbound',
      remoteId: arrival.remoteId,
      peerId: arrival.peerId,
      seq: arrival.seq,
      message: arrival.message,
    });
  });

  it('makes a write asked for while it is stopped once it runs again', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    const write = vi.fn(() => 'written');
    const written = kernelQueue.writeOutsideCrank(write);
    const calledWhileStopped = write.mock.calls.length;
    const rerun = kernelQueue.run(vi.fn());

    expect({ calledWhileStopped, result: await written }).toStrictEqual({
      calledWhileStopped: 0,
      result: 'written',
    });
    await kernelQueue.stopRunLoop();
    await rerun;
  });

  it('makes those writes before the first crank once it runs again', async () => {
    const { kernelStore, kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    const write = vi.fn();
    kernelQueue.writeOutsideCrank(write).catch(() => undefined);
    kernelStore.enqueueRun({
      type: 'send',
      target: kernelStore.initKernelObject(asVatId('v1')),
      message: { methargs: { body: '', slots: [] }, result: null },
    } as unknown as RunQueueItem);
    let writesBeforeCrank: number | undefined;
    const rerun = kernelQueue.run(async () => {
      writesBeforeCrank ??= write.mock.calls.length;
      return undefined;
    });
    await vi.waitFor(() => expect(writesBeforeCrank).toBeDefined());
    await kernelQueue.stopRunLoop();
    await rerun;

    expect(writesBeforeCrank).toBe(1);
  });

  it('rejects a write held while it is stopped when held requests are discarded', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    const write = vi.fn();
    const written = kernelQueue.writeOutsideCrank(write);
    const discarded = new Error('discarded');
    kernelQueue.discardHeldRequests(discarded);

    await expect(written).rejects.toBe(discarded);
    expect(write).not.toHaveBeenCalled();
  });

  it('fails while stopped, rejecting a write held for it', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop();
    await running;

    const written = kernelQueue.writeOutsideCrank(vi.fn());
    const failure = kernelQueue.failStoppedRunLoop(new Error('wipe failed'));

    await expect(written).rejects.toThrow('Kernel run loop died');
    expect({
      failure: failure.message,
      state: kernelQueue.getRunLoopStatus().state,
    }).toStrictEqual({ failure: 'wipe failed', state: 'failed' });
    await expect(kernelQueue.run(vi.fn())).rejects.toThrow(
      'run loop died and cannot be run again',
    );
  });

  it('refuses to fail a loop that is not stopped', async () => {
    const { kernelQueue } = await makeFixture(0);

    expect(() => kernelQueue.failStoppedRunLoop(new Error('x'))).toThrow(
      'run loop is not stopped',
    );
  });

  it('refuses peers and writes once stopped for good', async () => {
    const { kernelQueue } = await makeFixture(0);
    const running = kernelQueue.run(vi.fn());
    await kernelQueue.stopRunLoop({ forGood: true });
    await running;

    expect(() => kernelQueue.acceptRemoteInbound(arrival)).toThrow(
      'Kernel run loop is stopped',
    );
    await expect(kernelQueue.writeOutsideCrank(vi.fn())).rejects.toThrow(
      'Kernel run loop is stopped',
    );
  });
});
