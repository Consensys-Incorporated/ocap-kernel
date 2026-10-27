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
      model: 'openclaw',
    });
    expect(config.bootstrap).toBe(MATCHER_VAT_NAME);
    expect(config.services).toStrictEqual([
      'ocapURLIssuerService',
      'ocapURLRedemptionService',
      'languageModelService',
    ]);
    expect(config.vats[MATCHER_VAT_NAME]).toHaveProperty(
      'bundleSpec',
      `file:///tmp/matcher/${MATCHER_BUNDLE_FILENAME}`,
    );
  });

  it('passes the model through as a vat parameter', () => {
    const config = makeMatcherClusterConfig({
      bundleBaseUrl: 'x',
      model: 'openclaw/ranker',
    });
    expect(config.vats[MATCHER_VAT_NAME]?.parameters).toStrictEqual({
      model: 'openclaw/ranker',
    });
  });

  it('defaults forceReset to false', () => {
    const config = makeMatcherClusterConfig({
      bundleBaseUrl: 'x',
      model: 'openclaw',
    });
    expect(config.forceReset).toBe(false);
  });

  it('passes forceReset through when set', () => {
    const config = makeMatcherClusterConfig({
      bundleBaseUrl: 'x',
      model: 'openclaw',
      forceReset: true,
    });
    expect(config.forceReset).toBe(true);
  });
});
