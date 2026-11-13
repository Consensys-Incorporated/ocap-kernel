import { describe, it, expect } from 'vitest';

import type { KernelFacetSource } from './kernel-facet.ts';
import { makeKernelFacet } from './kernel-facet.ts';
import { kslot } from './liveslots/kernel-marshal.ts';
import type { KRef } from './types.ts';
import { asKRef, asSubclusterId } from '../test/branded.ts';

const makeMockKernel = (): KernelFacetSource => ({
  getPresence: async (kref: KRef, iface: string = 'Kernel Object') =>
    kslot(kref, iface),
  getStatus: async () =>
    Promise.resolve({
      vats: [],
      subclusters: [],
      runLoop: { state: 'running' },
    }),
  getSubcluster: () => undefined,
  getSubclusters: () => [],
  getSystemSubclusterRoot: () => asKRef('ko99'),
  launchSubcluster: async () =>
    Promise.resolve({
      subclusterId: asSubclusterId('s1'),
      rootKref: asKRef('ko1'),
      bootstrapResult: undefined,
      vatRootKrefs: {},
    }),
  pingVat: async () => Promise.resolve('pong'),
  queueMessage: async () => Promise.resolve({ body: '#null', slots: [] }),
  registerKernelServiceObject: () => ({
    name: 'test',
    kref: asKRef('ko1'),
    service: {},
    systemOnly: false,
  }),
  reset: async () => Promise.resolve(),
  terminateSubcluster: async () => Promise.resolve(),
});

describe('makeKernelFacet', () => {
  it('creates an exo with all dependency methods and ping', () => {
    const facet = makeKernelFacet(makeMockKernel());

    expect(typeof facet.getPresence).toBe('function');
    expect(typeof facet.getStatus).toBe('function');
    expect(typeof facet.getSubcluster).toBe('function');
    expect(typeof facet.getSubclusters).toBe('function');
    expect(typeof facet.getSystemSubclusterRoot).toBe('function');
    expect(typeof facet.launchSubcluster).toBe('function');
    expect(typeof facet.ping).toBe('function');
    expect(typeof facet.pingVat).toBe('function');
    expect(typeof facet.queueMessage).toBe('function');
    expect(typeof facet.registerKernelServiceObject).toBe('function');
    expect(typeof facet.reset).toBe('function');
    expect(typeof facet.terminateSubcluster).toBe('function');
  });

  it('ping returns "pong"', () => {
    const facet = makeKernelFacet(makeMockKernel());
    expect(facet.ping()).toBe('pong');
  });

  it('delegates dependency methods to the provided functions', async () => {
    const facet = makeKernelFacet(makeMockKernel());

    expect(facet.getSystemSubclusterRoot('test')).toBe('ko99');
    expect(await facet.getStatus()).toStrictEqual({
      vats: [],
      subclusters: [],
      runLoop: { state: 'running' },
    });
    expect(
      await facet.launchSubcluster({
        bootstrap: 'b',
        vats: { b: { bundleSpec: 'x' } },
      }),
    ).toStrictEqual({
      subclusterId: 's1',
      rootKref: 'ko1',
      bootstrapResult: undefined,
      vatRootKrefs: {},
    });
  });
});
