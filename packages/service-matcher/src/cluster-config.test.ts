import { describe, expect, it } from 'vitest';

import {
  makeMatcherClusterConfig,
  MATCHER_BUNDLE_FILENAME,
  MATCHER_VAT_NAME,
} from './cluster-config.ts';

describe('makeMatcherClusterConfig', () => {
  it('produces a config with the matcher vat as the bootstrap', () => {
    const config = makeMatcherClusterConfig({
      bundleBaseUrl: 'file:///tmp/matcher',
    });
    expect(config.bootstrap).toBe(MATCHER_VAT_NAME);
    expect(config.services).toStrictEqual([
      'ocapURLIssuerService',
      'ocapURLRedemptionService',
    ]);
    expect(config.vats[MATCHER_VAT_NAME]).toHaveProperty(
      'bundleSpec',
      `file:///tmp/matcher/${MATCHER_BUNDLE_FILENAME}`,
    );
  });

  it('defaults forceReset to false', () => {
    const config = makeMatcherClusterConfig({ bundleBaseUrl: 'x' });
    expect(config.forceReset).toBe(false);
  });

  it('passes forceReset through when set', () => {
    const config = makeMatcherClusterConfig({
      bundleBaseUrl: 'x',
      forceReset: true,
    });
    expect(config.forceReset).toBe(true);
  });
});
