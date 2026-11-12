import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { waitUntilQuiescent } from '@metamask/kernel-utils';
import { NodejsPlatformServices } from '@metamask/kernel-node-runtime';
import { kunser, makeKernelStore } from '@metamask/ocap-kernel';
import { rpcHandlers } from '@metamask/ocap-kernel/rpc';
import type { ClusterConfig, KRef } from '@metamask/ocap-kernel';
import { is } from '@metamask/superstruct';
import { describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeAuditedKernelOptions,
  makeKernel,
  makeMockLogger,
  makeTrackedKernel,
} from './utils.ts';

const heldVat = { bundleSpec: getBundleSpec('held-result-vat') };

/**
 * A kernel on a fresh in-memory store, with the store to inspect it by.
 *
 * @param systemSubclusters - System subclusters to launch at boot.
 * @returns The kernel and its store.
 */
async function setUp(
  systemSubclusters?: { name: string; config: ClusterConfig }[],
) {
  const kernelDatabase = await makeSQLKernelDatabase({
    dbFilename: ':memory:',
  });
  const kernelStore = makeKernelStore(kernelDatabase);
  const logger = makeMockLogger();
  const kernel = systemSubclusters
    ? await makeTrackedKernel(
        new NodejsPlatformServices({ logger }),
        kernelDatabase,
        {
          resetStorage: true,
          logger,
          systemSubclusters,
          ...makeAuditedKernelOptions(),
        },
      )
    : await makeKernel(kernelDatabase, true, logger);
  return { kernel, kernelStore };
}

describe('held results across real vats', () => {
  it('9a. gives launchSubcluster a bootstrapResult with a kpid that survives the RPC result struct', async () => {
    const { kernel, kernelStore } = await setUp();
    const launchSubclusterHandler = rpcHandlers.launchSubcluster;

    const result = await launchSubclusterHandler.implementation(
      { kernel } as never,
      { config: { bootstrap: 'main', vats: { main: heldVat } } },
    );

    expect(result.bootstrapResult?.kpid).toBeDefined();
    expect(is(result, launchSubclusterHandler.result)).toBe(true);
    expect(kernelStore.getHeldResults()).toStrictEqual([
      result.bootstrapResult?.kpid,
    ]);
    await kernel.releaseResult(result.bootstrapResult ?? {});
    expect(kernelStore.getHeldResults()).toStrictEqual([]);
  });

  it('9b. releases the bootstrapResult of a system subcluster itself', async () => {
    const { kernelStore } = await setUp([
      {
        name: 'sys',
        config: {
          bootstrap: 'sys',
          vats: { sys: heldVat },
          services: ['kernelFacet'],
        },
      },
    ]);
    await waitUntilQuiescent();

    expect(kernelStore.getHeldResults()).toStrictEqual([]);
  });

  it('9c. releases the bootstrapResult itself when a peer vat fails to launch', async () => {
    const { kernel, kernelStore } = await setUp();

    await expect(
      kernel.launchSubcluster({
        bootstrap: 'main',
        vats: {
          main: heldVat,
          broken: { bundleSpec: getBundleSpec('error-build-throw') },
        },
      }),
    ).rejects.toThrow(/.+/u);
    await waitUntilQuiescent();

    expect(kernelStore.getHeldResults()).toStrictEqual([]);
  });

  it('8. lets a system vat queue a message and release its result through the kernel facet', async () => {
    const { kernel, kernelStore } = await setUp([
      {
        name: 'sys',
        config: {
          bootstrap: 'sys',
          vats: { sys: heldVat },
          services: ['kernelFacet'],
        },
      },
    ]);
    const { rootKref: target, bootstrapResult } = await kernel.launchSubcluster(
      { bootstrap: 'main', vats: { main: heldVat } },
    );
    await kernel.releaseResult(bootstrapResult ?? {});
    const sysRoot = kernel.getSystemSubclusterRoot('sys') as KRef;

    const answer = await kernel.queueMessage(sysRoot, 'queueAndRelease', [
      target,
    ]);
    const decoded = kunser(answer) as { kpid?: string; slots: string[] };
    await kernel.releaseResult(answer);
    await waitUntilQuiescent();

    expect({
      kpidGiven: typeof decoded.kpid,
      slots: decoded.slots.length,
      held: kernelStore.getHeldResults(),
    }).toStrictEqual({ kpidGiven: 'string', slots: 1, held: [] });

    const twice = await kernel.queueMessage(sysRoot, 'releaseTwice', [target]);
    expect(kunser(twice)).toMatch(
      /^second release refused: .*not a held result/u,
    );
  });
});
