import type { ClusterConfig } from '@metamask/ocap-kernel';

/**
 * The bootstrap vat name used in the matcher's cluster config. Exported
 * so that host-side code reading the bootstrap result can address the
 * right vat.
 */
export const MATCHER_VAT_NAME = 'matcher';

/**
 * Filename of the matcher vat bundle as produced by `yarn bundle-vat` in
 * this package (the ocap-kernel CLI writes the bundle next to the source
 * as `index.bundle`). A launcher supplies a `bundleBaseUrl` pointing at
 * the directory containing this file.
 */
export const MATCHER_BUNDLE_FILENAME = 'index.bundle';

/**
 * Shape of the matcher subcluster's bootstrap result.
 */
export type MatcherBootstrapResult = {
  matcherUrl: string;
};

/**
 * Build a `ClusterConfig` for launching the matcher subcluster.
 *
 * The matcher requires the `languageModelService` kernel service for
 * ranking, so the daemon hosting this subcluster must have an LLM
 * configured (see the kernel CLI's `llm.json`).
 *
 * @param options - Configuration options.
 * @param options.bundleBaseUrl - Base URL (or filesystem path) where the
 * matcher vat bundle is reachable. The bundle filename is appended.
 * @param options.model - Model name the matcher sends with every ranking
 * request. For an openclaw gateway this is an agent target like
 * `openclaw` or `openclaw/<agentId>`.
 * @param options.forceReset - Whether to reset the subcluster on launch.
 * Defaults to `false`.
 * @returns A ClusterConfig ready for `kernel.launchSubcluster(...)`.
 */
export function makeMatcherClusterConfig(options: {
  bundleBaseUrl: string;
  model: string;
  forceReset?: boolean;
}): ClusterConfig {
  const { bundleBaseUrl, model, forceReset = false } = options;
  return {
    bootstrap: MATCHER_VAT_NAME,
    forceReset,
    services: [
      'ocapURLIssuerService',
      'ocapURLRedemptionService',
      'languageModelService',
    ],
    vats: {
      [MATCHER_VAT_NAME]: {
        bundleSpec: `${bundleBaseUrl}/${MATCHER_BUNDLE_FILENAME}`,
        parameters: { model },
      },
    },
  };
}
