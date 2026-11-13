import type { KernelFacet } from '@metamask/ocap-kernel';

import type { QueueMessageResult } from './background.ts';
import type { CapletManifest } from './controllers/index.ts';

// Type declarations for omnium dev console API.
declare global {
  /**
   * The E() function from @endo/eventual-send for making eventual sends.
   * Set globally in the trusted prelude before lockdown.
   *
   * @example
   * ```typescript
   * const kernel = await omnium.getKernel();
   * const status = await E(kernel).getStatus();
   * ```
   */
  // oxlint-disable-next-line id-length
  var E: typeof import('@endo/eventual-send').E;

  var kernel: KernelFacet | Promise<KernelFacet>;

  var omnium: {
    /**
     * Caplet management API.
     *
     * Methods that delegate to the controller vat via queueMessage return
     * raw CapData. Use `kunser()` to deserialize the results.
     */
    caplet: {
      install: (manifest: CapletManifest) => QueueMessageResult;
      uninstall: (capletId: string) => QueueMessageResult;
      list: () => QueueMessageResult;
      get: (capletId: string) => QueueMessageResult;
      getCapletRoot: (capletId: string) => Promise<string>;
      callCapletMethod: (
        capletId: string,
        method: string,
        args: unknown[],
      ) => QueueMessageResult;
      load: (
        id: string,
      ) => Promise<{ manifest: CapletManifest; bundle: unknown }>;
    };
  };
}

export {};
