import { makeDefaultExo } from '@metamask/kernel-utils';

import type { Kernel } from './Kernel.ts';

const kernelFacetMethodNames = [
  'getPresence',
  'getStatus',
  'getSubcluster',
  'getSubclusters',
  'getSystemSubclusterRoot',
  'launchSubcluster',
  'pingVat',
  'queueMessage',
  'registerKernelServiceObject',
  'releaseResult',
  'reset',
  'terminateSubcluster',
] as const;

/**
 * The subset of Kernel that the kernel facet exposes.
 */
export type KernelFacetSource = Pick<
  Kernel,
  (typeof kernelFacetMethodNames)[number]
>;

/**
 * The kernel facet interface.
 *
 * This is the interface provided as a vatpower to the bootstrap vat of a
 * system vat. It enables privileged kernel operations.
 */
export type KernelFacet = KernelFacetSource & {
  /**
   * Ping the kernel.
   *
   * @returns The string 'pong'.
   */
  ping: () => 'pong';
};

/**
 * Creates a kernel facet exo that provides privileged kernel operations.
 *
 * Binds each delegated method to the kernel instance so that private field
 * access works correctly when the methods are called through the exo.
 *
 * @param kernel - The kernel instance to bind methods from.
 * @returns The kernel facet exo.
 */
export function makeKernelFacet(kernel: KernelFacetSource): KernelFacet {
  const bound: Record<string, unknown> = {};
  for (const name of kernelFacetMethodNames) {
    bound[name] = kernel[name].bind(kernel);
  }
  return makeDefaultExo('kernelFacet', {
    ...bound,
    ping: () => 'pong' as const,
  }) as unknown as KernelFacet;
}
