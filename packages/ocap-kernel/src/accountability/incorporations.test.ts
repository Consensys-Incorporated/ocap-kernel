import type { VatStore } from '@metamask/kernel-store';
import { beforeEach, describe, expect, it } from 'vitest';

import { recordIncorporations } from './incorporations.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import type { KRef } from '../types.ts';
import { asVatId, asVRef } from '../../test/branded.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const vat = asVatId('v1');
const owner = asVatId('v2');
const durable = 'o+d10/1';

/**
 * A durable object's state as liveslots stores it.
 *
 * @param slots - The references in it.
 * @returns The state.
 */
const stateWith = (...slots: string[]): string =>
  JSON.stringify({ held: { body: '#"$0"', slots } });

describe('recordIncorporations', () => {
  let kernelStore: KernelStore;
  let vatStore: VatStore;
  let tracked: KRef;

  beforeEach(() => {
    kernelStore = makeKernelStore(makeMapKernelDatabase());
    vatStore = kernelStore.makeVatStore(vat);
    tracked = kernelStore.initKernelObject(owner);
    kernelStore.addCListEntry(vat, tracked, asVRef('o-1'));
    kernelStore.trackObject(tracked, owner);
  });

  it('records a tracked object newly written into a durable object', () => {
    recordIncorporations({
      kernelStore,
      vatStore,
      vatId: vat,
      sets: [[`vom.${durable}`, stateWith('o-1', 'o-2')]],
    });
    expect(kernelStore.getAccountabilityRecords()).toStrictEqual([
      {
        seq: 1,
        kind: 'incorporation',
        witness: 'liveslots',
        crankNumber: 0,
        kref: tracked,
        endpoint: vat,
        object: durable,
      },
    ]);
  });

  it('names the durable object as the kernel does, once exported', () => {
    const exported = kernelStore.initKernelObject(vat);
    kernelStore.addCListEntry(vat, exported, asVRef(durable));
    recordIncorporations({
      kernelStore,
      vatStore,
      vatId: vat,
      sets: [[`vom.${durable}`, stateWith('o-1')]],
    });
    expect(kernelStore.getAccountabilityRecords()).toStrictEqual([
      expect.objectContaining({ object: durable, objectKref: exported }),
    ]);
  });

  it('records an object once, not on every write of the state', () => {
    vatStore.updateKVData([[`vom.${durable}`, stateWith('o-1')]], []);
    recordIncorporations({
      kernelStore,
      vatStore,
      vatId: vat,
      sets: [[`vom.${durable}`, stateWith('o-1', 'o-2')]],
    });
    expect(kernelStore.getAccountabilityRecords()).toStrictEqual([]);
  });

  it.each([
    ['an untracked object', `vom.${durable}`, stateWith('o-2')],
    ['a reference the vat does not hold', `vom.${durable}`, stateWith('o-9')],
    ['a virtual object', 'vom.o+v10/1', stateWith('o-1')],
    ['a key that is not state', 'vom.dkind.10.descriptor', stateWith('o-1')],
    ['state that is not JSON', `vom.${durable}`, '{'],
    ['state of another shape', `vom.${durable}`, JSON.stringify(['o-1'])],
  ])('records nothing for %s', (_what, key, value) => {
    recordIncorporations({
      kernelStore,
      vatStore,
      vatId: vat,
      sets: [[key, value]],
    });
    expect(kernelStore.getAccountabilityRecords()).toStrictEqual([]);
  });
});
