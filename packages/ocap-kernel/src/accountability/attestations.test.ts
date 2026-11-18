import { beforeEach, describe, expect, it, vi } from 'vitest';

import { makeAttestationKeeper } from './attestations.ts';
import type { AttestationKeeper } from './attestations.ts';
import { makePartyVerifier } from './parties.ts';
import { makeKernelSigner, verifyKernelSignature } from './signing.ts';
import type { KernelSigner } from './signing.ts';
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
        enqueueInbox: vi.fn(async (_what: string, work: () => unknown) => {
          const outcome = (await work()) as
            | { value: unknown }
            | { failure: Error };
          if ('failure' in outcome) {
            throw outcome.failure;
          }
          return outcome.value;
        }),
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
      NonNullable<typeof kept>['countersignature']
    >;
    expect(
      await verifyKernelSignature({ payload: claim, ...countersignature }),
    ).toBe(true);
  });

  it("keeps an operator attestation for another kernel with that kernel's countersignature, and refuses one without", async () => {
    const otherDb = makeMapKernelDatabase();
    const otherPeerId = await seedIdentity(otherDb.kernelKVStore, 5);
    const otherStore = makeKernelStore(otherDb);
    const otherKeeper = makeKeeper(
      otherStore,
      makeKernelSigner({ kernelStore: otherStore, ensureIdentity: vi.fn() }),
    );
    const attestation = await party.attest({
      kind: 'operator',
      subject: otherPeerId,
      payload: null,
    });
    await expect(keeper.attest(attestation)).rejects.toThrow(
      `an operator attestation for ${otherPeerId} needs that kernel's countersignature`,
    );
    await otherKeeper.attest(attestation);
    const [countersigned] = await otherKeeper.getAttestations();
    await keeper.attest(countersigned as never);
    expect(await keeper.getAttestations({ kind: 'operator' })).toStrictEqual([
      countersigned,
    ]);
    await expect(
      keeper.attest({
        ...(countersigned as never as object),
        payload: 'changed',
      } as never),
    ).rejects.toThrow('does not check');
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
