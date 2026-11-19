import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAttestationKeeper } from './attestations.ts';
import type { AttestationKeeper } from './attestations.ts';
import { makePartyVerifier } from './parties.ts';
import { makeKernelSigner, verifyKernelSignature } from './signing.ts';
import type { KernelSigner } from './signing.ts';
import type { AttestationClaim, StoredAttestation } from './types.ts';
import type { KernelQueue } from '../KernelQueue.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import { makeTestParty, seedIdentity } from '../../test/identity.ts';
import type { TestParty } from '../../test/identity.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

describe('attestation keeper', () => {
  let kernelStore: KernelStore;
  let signer: KernelSigner;
  let keeper: AttestationKeeper;
  let peerId: string;
  let party: TestParty;

  const makeKeeper = (
    store: KernelStore,
    sign: KernelSigner,
  ): AttestationKeeper =>
    makeAttestationKeeper({
      kernelStore: store,
      kernelQueue: {
        writeOutsideCrank: vi.fn(async (write: () => unknown) => write()),
      } as unknown as KernelQueue,
      signer: sign,
      partyVerifier: makePartyVerifier(),
    });

  beforeEach(async () => {
    const kdb = makeMapKernelDatabase();
    peerId = await seedIdentity(kdb.kernelKVStore);
    kernelStore = makeKernelStore(kdb);
    signer = makeKernelSigner({ kernelStore, ensureIdentity: vi.fn() });
    keeper = makeKeeper(kernelStore, signer);
    party = await makeTestParty();
  });

  it('keeps an implementer attestation whose signature checks, once', async () => {
    const attestation = await party.attest({
      kind: 'implementer',
      subject: 'sha256:00',
      payload: { name: 'thing' },
    });
    await keeper.attest(attestation);
    await keeper.attest(attestation);
    expect(await keeper.getAttestations()).toStrictEqual([attestation]);
    expect(
      await keeper.getAttestations({
        kind: 'implementer',
        subject: 'sha256:00',
      }),
    ).toStrictEqual([attestation]);
    expect(
      await keeper.getAttestations({
        kind: 'implementer',
        subject: 'sha256:01',
      }),
    ).toStrictEqual([]);
    expect(await keeper.getAttestations({ kind: 'operator' })).toStrictEqual(
      [],
    );
  });

  it('countersigns an operator attestation for this kernel', async () => {
    const attestation = await party.attest({
      kind: 'operator',
      subject: peerId,
      payload: null,
    });
    await keeper.attest(attestation);
    const [kept] = await keeper.getAttestations({ kind: 'operator' });
    expect(kept).toStrictEqual({
      ...attestation,
      countersignature: {
        signer: peerId,
        incarnationId: expect.any(String),
        signature: expect.any(String),
      },
    });
    const { signature: _signature, ...claim } = attestation;
    const countersignature = kept?.countersignature as NonNullable<
      StoredAttestation['countersignature']
    >;
    expect(
      await verifyKernelSignature({ payload: claim, ...countersignature }),
    ).toBe(true);
  });

  describe('an operator attestation for another kernel', () => {
    let otherPeerId: string;
    let claim: AttestationClaim;
    let countersignature: NonNullable<StoredAttestation['countersignature']>;
    let countersigned: StoredAttestation;
    let thirdSigner: KernelSigner;

    const makeOtherSigner = async (seedByte: number): Promise<KernelSigner> => {
      const db = makeMapKernelDatabase();
      await seedIdentity(db.kernelKVStore, seedByte);
      const store = makeKernelStore(db);
      return makeKernelSigner({ kernelStore: store, ensureIdentity: vi.fn() });
    };

    beforeEach(async () => {
      const otherSigner = await makeOtherSigner(5);
      otherPeerId = await otherSigner.getPeerId();
      thirdSigner = await makeOtherSigner(6);
      const attestation = await party.attest({
        kind: 'operator',
        subject: otherPeerId,
        payload: null,
      });
      const { signature, ...bare } = attestation;
      claim = bare;
      const { payload: _payload, ...rest } = await otherSigner.sign(claim);
      countersignature = rest;
      countersigned = { ...claim, signature, countersignature };
    });

    it("keeps one with that kernel's countersignature", async () => {
      await keeper.attest(countersigned);
      expect(await keeper.getAttestations({ kind: 'operator' })).toStrictEqual([
        countersigned,
      ]);
    });

    it.each([
      [
        'none',
        async (): Promise<StoredAttestation> => {
          const { countersignature: _countersignature, ...bare } =
            countersigned;
          return bare;
        },
      ],
      [
        'by a third kernel',
        async (): Promise<StoredAttestation> => {
          const { payload: _payload, ...third } = await thirdSigner.sign(claim);
          return { ...countersigned, countersignature: third };
        },
      ],
      [
        'that does not check',
        async (): Promise<StoredAttestation> => {
          const { signature } = await thirdSigner.sign(claim);
          return {
            ...countersigned,
            countersignature: { ...countersignature, signature },
          };
        },
      ],
    ])('refuses one with a countersignature %s', async (_what, make) => {
      await expect(keeper.attest(await make())).rejects.toThrow(
        `an operator attestation for ${otherPeerId} needs that kernel's countersignature`,
      );
      expect(await keeper.getAttestations()).toStrictEqual([]);
    });

    it('refuses one whose countersignature it does not understand', async () => {
      await expect(
        keeper.attest({
          ...countersigned,
          countersignature: { ...countersignature, bogus: 1 },
        } as StoredAttestation),
      ).rejects.toThrow('bogus');
      expect(await keeper.getAttestations()).toStrictEqual([]);
    });

    it('refuses one whose payload changed', async () => {
      await expect(
        keeper.attest({ ...countersigned, payload: 'changed' }),
      ).rejects.toThrow('does not check');
      expect(await keeper.getAttestations()).toStrictEqual([]);
    });
  });

  it.each([
    [
      'a signature that does not check',
      async (): Promise<object> => ({
        ...(await party.attest({
          kind: 'implementer',
          subject: 'sha256:00',
          payload: null,
        })),
        subject: 'sha256:01',
      }),
      'does not check',
    ],
    [
      'an intent',
      async (): Promise<object> =>
        party.attest({ kind: 'intent', subject: 'ko1', payload: null }),
      'an intent is attested by the queueMessage it is passed to',
    ],
    [
      'a party of a scheme nobody verifies',
      async (): Promise<object> => ({
        kind: 'implementer',
        subject: 'sha256:00',
        party: 'did:key:z',
        payload: null,
        signature: '00',
      }),
      'no verifier for the party scheme "did"',
    ],
    [
      'a malformed attestation',
      async (): Promise<object> => ({ kind: 'implementer' }),
      'subject',
    ],
  ])('refuses %s', async (_what, make, problem) => {
    await expect(keeper.attest((await make()) as never)).rejects.toThrow(
      problem,
    );
    expect(await keeper.getAttestations()).toStrictEqual([]);
  });
});
