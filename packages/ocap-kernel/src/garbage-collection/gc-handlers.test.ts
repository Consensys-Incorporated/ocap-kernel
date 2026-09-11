import { describe, it, expect, beforeEach } from 'vitest';

import { makeMapKernelDatabase } from '../../test/storage.ts';
import { makeKernelStore } from '../store/index.ts';
import type { VatConfig, VatId } from '../types.ts';
import { performExportCleanup } from './gc-handlers.ts';

describe('performExportCleanup', () => {
  let kernelStore: ReturnType<typeof makeKernelStore>;

  /**
   * Register and initialize an endpoint so it can hold c-list entries.
   *
   * @param vatIds - The vats to bring into existence.
   */
  function givenVats(...vatIds: VatId[]): void {
    for (const vatId of vatIds) {
      kernelStore.setVatConfig(vatId, { sourceSpec: 'x' } as VatConfig);
      kernelStore.initEndpoint(vatId);
    }
  }

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    kernelStore.markInitialized();
    givenVats('v1', 'v2');
  });

  // `checkReachable` is what separates a retire from an abandon; the ownership
  // check precedes it, so both syscalls have to be covered.
  const actions = [
    { name: 'retireExports', checkReachable: true },
    { name: 'abandonExports', checkReachable: false },
  ] as const;

  it.each(actions)(
    'lets an owner give up its own export via $name',
    ({ checkReachable }) => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.clearReachableFlag('v1', kref);

      performExportCleanup([kref], checkReachable, 'v1', kernelStore);

      expect(kernelStore.getOwner(kref)).toBeUndefined();
      expect(kernelStore.hasCListEntry('v1', kref)).toBe(false);
    },
  );

  it.each(actions)(
    'refuses $name for an object owned by another endpoint',
    ({ name, checkReachable }) => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      // v2 holds it as an import, which is what makes the kref nameable in a
      // syscall from v2 at all.
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.clearReachableFlag('v2', kref);

      expect(() =>
        performExportCleanup([kref], checkReachable, 'v2', kernelStore),
      ).toThrow(`endpoint v2 issued ${name} for ${kref}, which is owned by v1`);

      // v1's claim survives intact, entry and ownership both.
      expect(kernelStore.getOwner(kref)).toBe('v1');
      expect(kernelStore.hasCListEntry('v1', kref)).toBe(true);
      expect(kernelStore.hasCListEntry('v2', kref)).toBe(true);
    },
  );

  it.each(actions)(
    'allows $name for an already-orphaned object',
    ({ checkReachable }) => {
      const kref = kernelStore.exportFromEndpoint('v1', 'o+1');
      kernelStore.translateRefKtoE('v2', kref, true);
      kernelStore.clearReachableFlag('v2', kref);
      kernelStore.clearReachableFlag('v1', kref);
      kernelStore.forgetKref('v1', kref);
      kernelStore.orphanKernelObject(kref, 'v1');

      // No claim is left to erase, so there is nothing for the guard to protect.
      expect(() =>
        performExportCleanup([kref], checkReachable, 'v2', kernelStore),
      ).not.toThrow();
      expect(kernelStore.hasCListEntry('v2', kref)).toBe(false);
    },
  );

  it('refuses retireExports for an object the owner still reaches', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');

    expect(() => performExportCleanup([kref], true, 'v1', kernelStore)).toThrow(
      `retireExports but ${kref} is still reachable`,
    );
    expect(kernelStore.getOwner(kref)).toBe('v1');
  });

  it('abandons an export the owner still reaches', () => {
    const kref = kernelStore.exportFromEndpoint('v1', 'o+1');

    performExportCleanup([kref], false, 'v1', kernelStore);

    expect(kernelStore.getOwner(kref)).toBeUndefined();
  });

  it.each(actions)(
    'refuses $name for a promise',
    ({ name, checkReachable }) => {
      const kpid = kernelStore.initKernelPromise()[0];
      kernelStore.exportFromEndpoint('v1', 'p+1');

      expect(() =>
        performExportCleanup([kpid], checkReachable, 'v1', kernelStore),
      ).toThrow(`endpoint v1 issued invalid ${name} for ${kpid}`);
    },
  );
});
