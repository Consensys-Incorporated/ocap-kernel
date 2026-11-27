import { describe, expect, it, vi } from 'vitest';

import {
  attestationSigningBytes,
  makePartyVerifier,
  partyScheme,
} from './parties.ts';
import { signingBytes } from './signing.ts';
import { makeTestParty } from '../../test/identity.ts';

describe('partyScheme', () => {
  it('is the part before the first colon', () => {
    expect(partyScheme('did:key:z6Mk')).toBe('did');
  });
});

describe('attestationSigningBytes', () => {
  it('covers the kind, subject, party and payload, and nothing else', () => {
    const claim = {
      kind: 'implementer' as const,
      subject: 'sha256:00',
      party: 'ed25519:00',
      payload: { a: 1 },
    };
    expect(
      attestationSigningBytes({ ...claim, extra: 1 } as never),
    ).toStrictEqual(signingBytes(claim));
  });
});

describe('makePartyVerifier', () => {
  it('verifies an ed25519 party on its own', async () => {
    const party = await makeTestParty();
    const data = new TextEncoder().encode('hello');
    const signature = await party.sign(data);
    const verifier = makePartyVerifier();
    expect(await verifier.verify({ party: party.party, data, signature })).toBe(
      true,
    );
    expect(
      await verifier.verify({
        party: party.party,
        data: new TextEncoder().encode('hullo'),
        signature,
      }),
    ).toBe(false);
    expect(
      await verifier.verify({ party: 'ed25519:zz', data, signature }),
    ).toBe(false);
  });

  it('verifies an attestation against the party it names', async () => {
    const party = await makeTestParty();
    const attestation = await party.attest({
      kind: 'implementer',
      subject: 'sha256:00',
      payload: null,
    });
    const verifier = makePartyVerifier();
    expect(await verifier.verifyAttestation(attestation)).toBe(true);
    expect(
      await verifier.verifyAttestation({
        ...attestation,
        subject: 'sha256:01',
      }),
    ).toBe(false);
  });

  it('uses a host verifier for its scheme, and refuses a scheme nobody verifies', async () => {
    const custom = vi.fn().mockResolvedValue(true);
    const verifier = makePartyVerifier({ custom });
    const data = new Uint8Array([1]);
    expect(
      await verifier.verify({ party: 'custom:alice', data, signature: '00' }),
    ).toBe(true);
    expect(custom).toHaveBeenCalledWith({
      party: 'custom:alice',
      data,
      signature: '00',
    });
    await expect(
      verifier.verify({ party: 'did:key:z', data, signature: '00' }),
    ).rejects.toThrow('no verifier for the party scheme "did"');
  });

  it('refuses a host verifier for the built-in scheme', () => {
    expect(() => makePartyVerifier({ ed25519: () => true })).toThrow(
      'the ed25519 scheme is built in',
    );
  });

  it('does not take a scheme from the object prototype', async () => {
    const verifier = makePartyVerifier();
    await expect(
      verifier.verify({
        party: 'constructor:x',
        data: new Uint8Array(),
        signature: '00',
      }),
    ).rejects.toThrow('no verifier for the party scheme "constructor"');
  });
});
