// Unknown why this fails, but not worth it to chase down.
import { mergeConfig as mergeVitestConfig } from 'vitest/config';

// This file is in JS because otherwise Vitest can't import it.

/**
 * @typedef {import('vitest/config').ConfigEnv} ConfigEnv
 */

/**
 * @typedef {Parameters<typeof mergeVitestConfig>} MergeParams
 */

/**
 * Merge a Vitest config with the default config. Handles generic "development"
 * mode modifications to the config, for use with all test configs unless
 * otherwise specified.
 *
 * @param {ConfigEnv} args - The arguments to pass to the Vitest config.
 * @param {...MergeParams[number]} rest - The Vitest config to merge.
 * @returns {ReturnType<typeof mergeVitestConfig>} The merged Vitest config.
 */
export const mergeConfig = (args, ...rest) => {
  const config = mergeVitestConfig(...rest);

  // This breaks tests in packages if set
  delete config.test?.projects;

  if (args.mode === 'development') {
    delete config.test.coverage;
  } else {
    config.test.coverage.thresholds = {};
  }
  return config;
};
