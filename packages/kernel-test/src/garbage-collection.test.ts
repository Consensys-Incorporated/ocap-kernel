import type { KernelDatabase } from '@metamask/kernel-store';
import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { Kernel, kunser, makeKernelStore } from '@metamask/ocap-kernel';
import type {
  ClusterConfig,
  KRef,
  KernelStore,
  VatId,
} from '@metamask/ocap-kernel';
import { expect, beforeEach, describe, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeMockLogger,
  parseReplyBody,
  runTestVats,
} from './utils.ts';

/**
 * Make a test subcluster with vats for GC testing
 *
 * @param extraImporters - Names of additional importer vats to include, for
 * topologies where more than one vat shares the same exported object.
 * @returns The test subcluster
 */
function makeTestSubcluster(extraImporters: string[] = []): ClusterConfig {
  return {
    bootstrap: 'exporter',
    forceReset: true,
    vats: {
      exporter: {
        bundleSpec: getBundleSpec('exporter-vat'),
        parameters: {
          name: 'Exporter',
        },
      },
      importer: {
        bundleSpec: getBundleSpec('importer-vat'),
        parameters: {
          name: 'Importer',
        },
      },
      ...Object.fromEntries(
        extraImporters.map((name) => [
          name,
          {
            bundleSpec: getBundleSpec('importer-vat'),
            parameters: { name },
          },
        ]),
      ),
    },
  };
}

const CRANKS_PER_REAP = 3;
const MAX_REAP_ATTEMPTS = 10;

describe('Garbage Collection', () => {
  let kernel: Kernel;
  let kernelDatabase: KernelDatabase;
  let kernelStore: KernelStore;
  let exporterKRef: KRef;
  let importerKRef: KRef;
  let exporterVatId: VatId;
  let importerVatId: VatId;

  beforeEach(async () => {
    kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    kernelStore = makeKernelStore(kernelDatabase);
    kernel = await makeKernel(kernelDatabase, true, makeMockLogger());
    await runTestVats(kernel, makeTestSubcluster());

    const vats = kernel.getVats();
    exporterVatId = vats.find(
      (rows) => rows.config.parameters?.name === 'Exporter',
    )?.id as VatId;
    importerVatId = vats.find(
      (rows) => rows.config.parameters?.name === 'Importer',
    )?.id as VatId;
    exporterKRef = kernelStore.getRootObject(exporterVatId) as KRef;
    importerKRef = kernelStore.getRootObject(importerVatId) as KRef;
  });

  /**
   * Give a vat a chance to notice a dropped object and tell the kernel.
   *
   * A reap only reports what the engine collected before `bringOutYourDead`
   * ran, which one round of `gc()` does not guarantee includes the dropped
   * presence, hence the retries.
   *
   * @param options - Options bag.
   * @param options.vatId - The vat to reap.
   * @param options.rootKRef - That vat's root object.
   * @param options.isSettled - Predicate that holds once the kernel has seen
   * the drop.
   */
  async function reapAndSettle({
    vatId,
    rootKRef,
    isSettled,
  }: {
    vatId: VatId;
    rootKRef: KRef;
    isSettled: () => boolean;
  }): Promise<void> {
    for (let attempt = 0; attempt < MAX_REAP_ATTEMPTS; attempt++) {
      kernel.reapVats((id) => id === vatId);
      for (let i = 0; i < CRANKS_PER_REAP; i++) {
        await kernel.queueMessage(rootKRef, 'noop', []);
        await waitUntilQuiescent(500);
      }
      if (isSettled()) {
        return;
      }
    }
  }

  it('objects are tracked with reference counts', async () => {
    const objectId = 'test-object';
    // Create an object in the exporter vat
    const createObjectData = await kernel.queueMessage(
      exporterKRef,
      'createObject',
      [objectId],
    );
    const createObjectRef = createObjectData.slots[0] as KRef;
    // Held only by the resolved promise's value, which still carries the slot
    expect(kernelStore.getObjectRefCount(createObjectRef)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });
    // Send the object to the importer vat
    const objectRef = kunser(createObjectData);
    await kernel.queueMessage(importerKRef, 'storeImport', [objectRef]);
    await waitUntilQuiescent();
    // Check that the object is reachable from the exporter vat
    const exporterReachable = kernelStore.getReachableFlag(
      exporterVatId,
      createObjectRef,
    );
    expect(exporterReachable).toBe(true);
    // Check that the object is reachable as a promise from the importer vat
    const importerKref = kernelStore.erefToKref(importerVatId, 'p-1') as KRef;
    expect(kernelStore.hasCListEntry(importerVatId, importerKref)).toBe(true);
    expect(kernelStore.getRefCount(importerKref)).toBe(1);
    // Use the object
    const useResult = await kernel.queueMessage(importerKRef, 'useImport', []);
    await waitUntilQuiescent();
    expect(parseReplyBody(useResult.body)).toBe(objectId);
  });

  it('should trigger GC syscalls through bringOutYourDead', async () => {
    // Create an object in the exporter vat with a known ID
    const objectId = 'test-object';
    const createObjectData = await kernel.queueMessage(
      exporterKRef,
      'createObject',
      [objectId],
    );
    await waitUntilQuiescent();
    const createObjectRef = createObjectData.slots[0] as KRef;

    expect(kernelStore.getObjectRefCount(createObjectRef)).toStrictEqual({
      reachable: 1,
      recognizable: 1,
    });

    // Store the reference in the importer vat
    const objectRef = kunser(createObjectData);
    await kernel.queueMessage(importerKRef, 'storeImport', [
      objectRef,
      objectId,
    ]);
    await waitUntilQuiescent();

    // Verify object is tracked in both vats
    const importerHasObject = await kernel.queueMessage(
      importerKRef,
      'listImportedObjects',
      [],
    );
    expect(parseReplyBody(importerHasObject.body)).toContain(objectId);

    const exporterHasObject = await kernel.queueMessage(
      exporterKRef,
      'isObjectPresent',
      [objectId],
    );
    expect(parseReplyBody(exporterHasObject.body)).toBe(true);

    // Make a weak reference to the object in the importer vat
    // This should eventually trigger dropImports when GC runs
    await kernel.queueMessage(importerKRef, 'makeWeak', [objectId]);
    await waitUntilQuiescent();

    await reapAndSettle({
      vatId: importerVatId,
      rootKRef: importerKRef,
      isSettled: () => {
        const { reachable, recognizable } =
          kernelStore.getObjectRefCount(createObjectRef);
        return reachable === 1 && recognizable === 2;
      },
    });

    // Check reference counts after dropImports
    const afterWeakRefCounts = kernelStore.getObjectRefCount(createObjectRef);
    expect(afterWeakRefCounts.reachable).toBe(1);
    expect(afterWeakRefCounts.recognizable).toBe(2);

    // Now completely forget the import in the importer vat
    // This should trigger retireImports when GC runs
    await kernel.queueMessage(importerKRef, 'forgetImport', []);
    await waitUntilQuiescent();

    await reapAndSettle({
      vatId: importerVatId,
      rootKRef: importerKRef,
      isSettled: () => {
        const { reachable, recognizable } =
          kernelStore.getObjectRefCount(createObjectRef);
        return reachable === 1 && recognizable === 1;
      },
    });

    // Check reference counts after retireImports
    const afterForgetRefCounts = kernelStore.getObjectRefCount(createObjectRef);
    expect(afterForgetRefCounts.reachable).toBe(1);
    expect(afterForgetRefCounts.recognizable).toBe(1);

    // Now forget the object in the exporter vat
    // This should trigger retireExports when GC runs
    await kernel.queueMessage(exporterKRef, 'forgetObject', [objectId]);
    await waitUntilQuiescent();

    // Schedule a final reap
    kernel.reapVats((vatId) => vatId === exporterVatId);

    // Run a crank to ensure GC completes
    await kernel.queueMessage(exporterKRef, 'noop', []);
    await waitUntilQuiescent(50);

    // Verify the object has been completely removed
    const exporterFinalCheck = await kernel.queueMessage(
      exporterKRef,
      'isObjectPresent',
      [objectId],
    );
    expect(parseReplyBody(exporterFinalCheck.body)).toBe(false);
  }, 60000);

  describe('an object shared by two importers', () => {
    let secondImporterKRef: KRef;
    let secondImporterVatId: VatId;

    beforeEach(async () => {
      kernelDatabase = await makeSQLKernelDatabase({ dbFilename: ':memory:' });
      kernelStore = makeKernelStore(kernelDatabase);
      kernel = await makeKernel(kernelDatabase, true, makeMockLogger());
      await runTestVats(kernel, makeTestSubcluster(['Importer2']));

      const vats = kernel.getVats();
      const idOf = (name: string): VatId =>
        vats.find((row) => row.config.parameters?.name === name)?.id as VatId;
      exporterVatId = idOf('Exporter');
      importerVatId = idOf('Importer');
      secondImporterVatId = idOf('Importer2');
      exporterKRef = kernelStore.getRootObject(exporterVatId) as KRef;
      importerKRef = kernelStore.getRootObject(importerVatId) as KRef;
      secondImporterKRef = kernelStore.getRootObject(
        secondImporterVatId,
      ) as KRef;
    });

    it('survives until both importers let go', async () => {
      const objectId = 'shared-object';
      const createObjectData = await kernel.queueMessage(
        exporterKRef,
        'createObject',
        [objectId],
      );
      const sharedKRef = createObjectData.slots[0] as KRef;
      const objectRef = kunser(createObjectData);

      for (const importer of [importerKRef, secondImporterKRef]) {
        await kernel.queueMessage(importer, 'storeImport', [
          objectRef,
          objectId,
        ]);
      }
      await waitUntilQuiescent();

      expect(kernelStore.getImporters(sharedKRef)).toStrictEqual(
        [importerVatId, secondImporterVatId].sort(),
      );
      // Two importers, plus the resolved createObject promise whose value
      // still carries the slot
      expect(kernelStore.getObjectRefCount(sharedKRef)).toStrictEqual({
        reachable: 3,
        recognizable: 3,
      });

      await kernel.queueMessage(importerKRef, 'makeWeak', [objectId]);
      await kernel.queueMessage(importerKRef, 'forgetImport', []);
      await waitUntilQuiescent();
      await reapAndSettle({
        vatId: importerVatId,
        rootKRef: importerKRef,
        isSettled: () =>
          !kernelStore.getImporters(sharedKRef).includes(importerVatId),
      });

      // The exporter must not have been told to drop it: the second importer
      // legitimately still holds it
      expect(kernelStore.getReachableFlag(exporterVatId, sharedKRef)).toBe(
        true,
      );
      expect(kernelStore.getImporters(sharedKRef)).toStrictEqual([
        secondImporterVatId,
      ]);
      expect(
        parseReplyBody(
          (
            await kernel.queueMessage(exporterKRef, 'isObjectPresent', [
              objectId,
            ])
          ).body,
        ),
      ).toBe(true);

      expect(
        parseReplyBody(
          (
            await kernel.queueMessage(secondImporterKRef, 'useImport', [
              objectId,
            ])
          ).body,
        ),
      ).toBe(objectId);

      await kernel.queueMessage(secondImporterKRef, 'makeWeak', [objectId]);
      await kernel.queueMessage(secondImporterKRef, 'forgetImport', []);
      await waitUntilQuiescent();
      await reapAndSettle({
        vatId: secondImporterVatId,
        rootKRef: secondImporterKRef,
        isSettled: () => {
          const { reachable, recognizable } =
            kernelStore.getObjectRefCount(sharedKRef);
          return (
            kernelStore.getImporters(sharedKRef).length === 0 &&
            reachable === 1 &&
            recognizable === 1
          );
        },
      });

      expect(kernelStore.getImporters(sharedKRef)).toStrictEqual([]);
      // Only the createObject result's stored value still names it
      expect(kernelStore.getObjectRefCount(sharedKRef)).toStrictEqual({
        reachable: 1,
        recognizable: 1,
      });
    }, 60000);
  });
});
