import { makeSQLKernelDatabase } from '@metamask/kernel-store/sqlite/nodejs';
import { Kernel } from '@metamask/ocap-kernel';
import type { ClusterConfig, SubclusterId, VatId } from '@metamask/ocap-kernel';
import { beforeEach, describe, expect, it } from 'vitest';

import {
  getBundleSpec,
  makeKernel,
  makeTestLogger,
  runTestVats,
} from './utils.ts';

/**
 * Make a test subcluster with vats for subcluster testing
 *
 * @param name - The name of the subcluster
 * @returns A cluster configuration for testing
 */
function makeTestSubcluster(name: string): ClusterConfig {
  return {
    bootstrap: 'alice',
    forceReset: true,
    vats: {
      alice: {
        bundleSpec: getBundleSpec('subcluster-vat'),
        parameters: {
          name: 'Alice',
          subcluster: name,
        },
      },
      bob: {
        bundleSpec: getBundleSpec('subcluster-vat'),
        parameters: {
          name: 'Bob',
          subcluster: name,
        },
      },
    },
  };
}

describe('Subcluster functionality', () => {
  let kernel: Kernel;

  beforeEach(async () => {
    const kernelDatabase = await makeSQLKernelDatabase({
      dbFilename: ':memory:',
    });
    const { logger } = makeTestLogger();
    kernel = await makeKernel(kernelDatabase, true, logger);
  });

  it('can create and manage multiple subclusters', async () => {
    // Create first subcluster
    const subcluster1 = makeTestSubcluster('subcluster1');
    const bootstrapResult1 = await runTestVats(kernel, subcluster1);
    expect(bootstrapResult1).toBe('bootstrap complete');

    // Create second subcluster
    const subcluster2 = makeTestSubcluster('subcluster2');
    const bootstrapResult2 = await runTestVats(kernel, subcluster2);
    expect(bootstrapResult2).toBe('bootstrap complete');

    // Verify subclusters exist
    const subclusters = kernel.getSubclusters();
    expect(subclusters).toHaveLength(2);
    expect(subclusters[0]?.id).toBe('s1');
    expect(subclusters[1]?.id).toBe('s2');

    // Verify vats are in correct subclusters
    const vats = kernel.getVats();
    expect(vats).toHaveLength(4); // 2 vats per subcluster

    const subcluster1Vats = kernel.getSubclusterVats('s1' as SubclusterId);
    expect(subcluster1Vats).toHaveLength(2);
    expect(subcluster1Vats).toContain('v1');
    expect(subcluster1Vats).toContain('v2');

    const subcluster2Vats = kernel.getSubclusterVats('s2' as SubclusterId);
    expect(subcluster2Vats).toHaveLength(2);
    expect(subcluster2Vats).toContain('v3');
    expect(subcluster2Vats).toContain('v4');
  });

  it('can terminate a subcluster', async () => {
    // Create subcluster
    const subcluster = makeTestSubcluster('subcluster1');
    await runTestVats(kernel, subcluster);

    // Verify initial state
    expect(kernel.getSubclusters()).toHaveLength(1);
    expect(kernel.getVats()).toHaveLength(2);

    // Terminate subcluster
    await kernel.terminateSubcluster('s1' as SubclusterId);

    // Verify subcluster and its vats are gone
    expect(kernel.getSubclusters()).toHaveLength(0);
    expect(kernel.getVats()).toHaveLength(0);
    expect(kernel.getSubcluster('s1' as SubclusterId)).toBeUndefined();
  });

  it('can check if a vat belongs to a subcluster', async () => {
    // Create subcluster
    const subcluster = makeTestSubcluster('subcluster1');
    await runTestVats(kernel, subcluster);

    // Verify vat membership
    expect(kernel.isVatInSubcluster('v1' as VatId, 's1' as SubclusterId)).toBe(
      true,
    );
    expect(kernel.isVatInSubcluster('v2' as VatId, 's1' as SubclusterId)).toBe(
      true,
    );
    expect(kernel.isVatInSubcluster('v1' as VatId, 's2' as SubclusterId)).toBe(
      false,
    );
  });

  it('can handle subcluster operations with non-existent subclusters', async () => {
    expect(() =>
      kernel.getSubclusterVats('nonexistent' as SubclusterId),
    ).toThrow('Subcluster does not exist');
    await expect(
      kernel.terminateSubcluster('nonexistent' as SubclusterId),
    ).rejects.toThrow('Subcluster does not exist');
  });

  it('can handle subcluster operations with terminated vats', async () => {
    // Create subcluster
    const subcluster = makeTestSubcluster('subcluster1');
    await runTestVats(kernel, subcluster);

    // Terminate a vat
    await kernel.terminateVat('v2' as VatId);
    kernel.collectGarbage();

    // Verify vat is removed from subcluster
    const subclusterVats = kernel.getSubclusterVats('s1' as SubclusterId);
    expect(subclusterVats).toHaveLength(1);
    expect(subclusterVats).not.toContain('v2');
  });
});
