import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { makeKernelStore } from '@metamask/ocap-kernel';
import { describe, expect, it, beforeEach } from 'vitest';

import {
  extractTestLogs,
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runResume,
  runTestVats,
} from './utils.ts';

describe('Vat Lifecycle', { timeout: 30_000 }, () => {
  let logger: ReturnType<typeof makeTestLogger>;

  beforeEach(async () => {
    logger = makeTestLogger();
  });

  it('should clean up manually terminated vats', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernel = await makeKernel(
      kernelDatabase,
      true,
      logger.logger.subLogger({ tags: ['test'] }),
    );
    const kernelStore = makeKernelStore(kernelDatabase);

    const subcluster = {
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('logger-vat'),
          parameters: { name: 'CrashTestVat' },
        },
      },
    };

    await runTestVats(kernel, subcluster);
    await waitUntilQuiescent();

    const initialVats = kernel.getVats();
    const crasherVat = initialVats.find(
      ({ config }) => config.parameters?.name === 'CrashTestVat',
    );
    const crasherVatId = crasherVat?.id as string;
    expect(crasherVatId).toBeDefined();

    // Manually terminate the vat (simulating actual crash recovery)
    await kernel.terminateVat(crasherVatId);
    await waitUntilQuiescent();

    // Verify vat is cleaned up
    const finalVats = kernel.getVats();
    const activeCrasherVat = finalVats.find(({ id }) => id === crasherVatId);
    expect(activeCrasherVat).toBeUndefined();

    // Trigger garbage collection to clean up terminated vat objects
    kernel.collectGarbage();
    await waitUntilQuiescent();

    // Verify kernel store cleanup - root object should be cleaned up after GC
    const rootObject = kernelStore.getRootObject(crasherVatId);
    expect(rootObject).toBeUndefined();
  });

  it('should handle messages to terminated vat objects gracefully', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernel = await makeKernel(
      kernelDatabase,
      true,
      logger.logger.subLogger({ tags: ['test'] }),
    );
    const kernelStore = makeKernelStore(kernelDatabase);

    // Create two vats - one will be terminated, the other will try to send messages to it
    const subcluster = {
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('persistence-counter-vat'),
          parameters: { name: 'CounterLiveVat' },
        },
        target: {
          bundleSpec: getBundleSpec('persistence-counter-vat'),
          parameters: { name: 'CounterDeadVat' },
        },
      },
    };

    expect(await runTestVats(kernel, subcluster)).toBe(
      'Counter initialized with count: 1',
    );
    await waitUntilQuiescent();

    const vats = kernel.getVats();
    const liveVat = vats.find(
      ({ config }) => config.parameters?.name === 'CounterLiveVat',
    );
    const deadVat = vats.find(
      ({ config }) => config.parameters?.name === 'CounterDeadVat',
    );

    const liveVatId = liveVat?.id as string;
    const deadVatId = deadVat?.id as string;
    expect(liveVatId).toBeDefined();
    expect(deadVatId).toBeDefined();

    const deadRootObject = kernelStore.getRootObject(deadVatId) as string;
    expect(await runResume(kernel, deadRootObject)).toBe(
      'Counter incremented to: 2',
    );
    await waitUntilQuiescent();
    const liveRootObject = kernelStore.getRootObject(liveVatId) as string;
    expect(await runResume(kernel, liveRootObject)).toBe(
      'Counter incremented to: 2',
    );
    await waitUntilQuiescent();

    // Terminate the target vat
    await kernel.terminateVat(deadVatId);
    await waitUntilQuiescent();

    // Verify that only the live target vat is still running
    const remainingVats = kernel.getVats();
    expect(remainingVats).toHaveLength(1);
    expect(remainingVats[0]?.id).toBe(liveVatId);

    // Try to send a message to the terminated vat's root object — rejects
    await expect(
      kernel.queueMessage(deadRootObject, 'resume', []),
    ).rejects.toThrow('[KERNEL:OBJECT_DELETED]');

    // Verify that messaging works as expected
    expect(await runResume(kernel, liveRootObject)).toBe(
      'Counter incremented to: 3',
    );

    // The target root object should be cleaned up after GC
    expect(kernelStore.getRootObject(deadVatId)).toBeUndefined();
  });

  it('restarts one vat twice through the run loop', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger: restartLogger, entries } = makeTestLogger();
    const kernel = await makeKernel(kernelDatabase, true, restartLogger);

    await kernel.launchSubcluster({
      bootstrap: 'alice',
      forceReset: true,
      vats: {
        alice: {
          bundleSpec: getBundleSpec('resume-vat'),
          parameters: { name: 'Alice' },
        },
        // `resume-vat`'s bootstrap introduces its peers to each other, so the
        // subcluster needs all three.
        bob: {
          bundleSpec: getBundleSpec('resume-vat'),
          parameters: { name: 'Bob' },
        },
        carol: {
          bundleSpec: getBundleSpec('resume-vat'),
          parameters: { name: 'Carol' },
        },
      },
    });
    await waitUntilQuiescent();

    // The request is a run queue item, so each of these resolves only once the
    // run loop has taken it and the new worker has answered. `start count`
    // comes from the vat's own baggage, so it counts incarnations: a restart
    // that settled its caller without replacing the worker would not move it.
    await kernel.restartVat('v1');
    await kernel.restartVat('v1');
    await waitUntilQuiescent(1000);

    expect(extractTestLogs(entries, 'v1')).toContain('Alice: start count: 3');
  });

  it('leaves no record of a terminated vat for the next boot to restore', async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const kernel = await makeKernel(
      kernelDatabase,
      true,
      logger.logger.subLogger({ tags: ['test'] }),
    );
    const kernelStore = makeKernelStore(kernelDatabase);

    await runTestVats(kernel, {
      bootstrap: 'main',
      vats: {
        main: {
          bundleSpec: getBundleSpec('logger-vat'),
          parameters: { name: 'DoomedVat' },
        },
      },
    });
    await waitUntilQuiescent();
    const vatId = kernel.getVats()[0]?.id as string;

    await kernel.terminateVat(vatId);
    await waitUntilQuiescent();
    // The mark is what schedules this, and it is dropped once the sweep is
    // done — so the `vatConfig` row it never touches is the thing that decides
    // whether the vat is active after it.
    kernel.collectGarbage();
    await waitUntilQuiescent();

    expect(kernelStore.isVatActive(vatId)).toBe(false);
    expect([...kernelStore.getAllVatRecords()]).toStrictEqual([]);
  });
});
