import { describe, it, expect } from 'vitest';

import { asKRef } from '../../../test/branded.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

describe('held results', () => {
  it('takes a count on the promise and records when', () => {
    const kdb = makeMapKernelDatabase();
    const ks = makeKernelStore(kdb);
    const [kpid] = ks.initKernelPromise();

    ks.holdResult(kpid);

    expect({
      held: ks.isResultHeld(kpid),
      all: ks.getHeldResults(),
      refCount: ks.getRefCount(kpid),
      row: kdb.kernelKVStore.get(`heldResult.${kpid}`),
      violations: ks.auditRefCounts(),
    }).toStrictEqual({
      held: true,
      all: [kpid],
      // The decision the promise is owed, and the hold.
      refCount: 2,
      row: expect.stringMatching(/^\d{13}$/u),
      violations: [],
    });
  });

  it('gives the count back on release', () => {
    const kdb = makeMapKernelDatabase();
    const ks = makeKernelStore(kdb);
    const [kpid] = ks.initKernelPromise();
    ks.holdResult(kpid);

    expect(ks.releaseHeldResult(kpid)).toBe(true);

    expect({
      held: ks.isResultHeld(kpid),
      all: ks.getHeldResults(),
      refCount: ks.getRefCount(kpid),
      row: kdb.kernelKVStore.get(`heldResult.${kpid}`),
    }).toStrictEqual({ held: false, all: [], refCount: 1, row: undefined });
  });

  it('does not release a promise that is not held', () => {
    const ks = makeKernelStore(makeMapKernelDatabase());
    const [kpid] = ks.initKernelPromise();

    expect(ks.releaseHeldResult(kpid)).toBe(false);

    expect(ks.getRefCount(kpid)).toBe(1);
  });

  it('does not record a hold on a promise that is gone', () => {
    const kdb = makeMapKernelDatabase();
    const ks = makeKernelStore(kdb);

    expect(() => ks.holdResult(asKRef('kp99'))).toThrow('deleted kref');
    expect(ks.getHeldResults()).toStrictEqual([]);
  });
});
