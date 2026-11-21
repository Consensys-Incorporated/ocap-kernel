import { describe, it, expect } from 'vitest';

import * as indexModule from './index.ts';

describe('index', () => {
  it('has the expected exports', () => {
    expect(Object.keys(indexModule).sort()).toStrictEqual([
      'AllowedGlobalNameStruct',
      'CapDataStruct',
      'ClusterConfigStruct',
      'Kernel',
      'KernelStatusStruct',
      'RunLoopStatusStruct',
      'SubclusterStruct',
      'VatConfigStruct',
      'VatHandle',
      'VatIdStruct',
      'VatSupervisor',
      'attestationSigningBytes',
      'canonicalJson',
      'createDefaultEndowments',
      'generateMnemonic',
      'initTransport',
      'insistKRef',
      'insistSubclusterId',
      'isKRef',
      'isValidMnemonic',
      'isVatConfig',
      'isVatId',
      'krefOf',
      'kser',
      'kslot',
      'kunser',
      'makeKernelFacet',
      'makeKernelStore',
      'makePartyVerifier',
      'mnemonicToSeed',
      'parseRef',
      'partyScheme',
      'signingBytes',
      'verifyKernelSignature',
      'verifySegments',
    ]);
  });
});
