import { describe, expect, it } from 'vitest';

import {
  OCAP_JSONRPC_BUNDLE_FILENAME,
  OCAP_JSONRPC_SOCKET_CHANNEL,
  OCAP_JSONRPC_VAT_NAME,
  makeOcapJsonrpcClusterConfig,
} from './cluster-config.ts';

describe('makeOcapJsonrpcClusterConfig', () => {
  it('produces a config with the ocap JSON-RPC vat as the bootstrap', () => {
    const config = makeOcapJsonrpcClusterConfig({
      bundleBaseUrl: 'file:///tmp/jsonrpc',
      socketPath: '/tmp/ocap-jsonrpc.sock',
    });
    expect(config.bootstrap).toBe(OCAP_JSONRPC_VAT_NAME);
    expect(config.services).toStrictEqual(['ocapURLRedemptionService']);
    expect(config.io?.[OCAP_JSONRPC_SOCKET_CHANNEL]).toStrictEqual({
      type: 'socket',
      path: '/tmp/ocap-jsonrpc.sock',
    });
    expect(config.vats[OCAP_JSONRPC_VAT_NAME]).toHaveProperty(
      'bundleSpec',
      `file:///tmp/jsonrpc/${OCAP_JSONRPC_BUNDLE_FILENAME}`,
    );
  });

  it('defaults forceReset to false', () => {
    const config = makeOcapJsonrpcClusterConfig({
      bundleBaseUrl: 'x',
      socketPath: '/x.sock',
    });
    expect(config.forceReset).toBe(false);
  });

  it('passes forceReset through when set', () => {
    const config = makeOcapJsonrpcClusterConfig({
      bundleBaseUrl: 'x',
      socketPath: '/x.sock',
      forceReset: true,
    });
    expect(config.forceReset).toBe(true);
  });
});
