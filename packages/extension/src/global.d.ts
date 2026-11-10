import type { KernelFacet } from '@metamask/ocap-kernel';

// Type declarations for kernel dev console API.
declare global {
  /**
   * The E() function from @endo/eventual-send for making eventual sends.
   * Set globally in the trusted prelude before lockdown.
   *
   * @example
   * ```typescript
   * const kernel = await kernel.getKernel();
   * const status = await E(kernel).getStatus();
   * ```
   */
  // oxlint-disable-next-line id-length
  var E: typeof import('@endo/eventual-send').E;

  var kernel: KernelFacet | Promise<KernelFacet>;
}

export {};
