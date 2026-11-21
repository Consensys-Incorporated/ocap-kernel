import { describe, expect, it } from 'vitest';

import { makeSegmentIssuer, MAX_SEGMENTS, verifySegments } from './segments.ts';
import type { Segment, SegmentIssuer } from './segments.ts';
import { makeKernelSigner, verifyKernelSignature } from './signing.ts';
import type { KernelSigner } from './signing.ts';
import { makeKernelStore } from '../store/index.ts';
import type { KernelStore } from '../store/index.ts';
import { asKRef, asRemoteId, asRRef, asVatId } from '../../test/branded.ts';
import { seedIdentity } from '../../test/identity.ts';
import { makeMapKernelDatabase } from '../../test/storage.ts';

const owner = asVatId('v1');
const holder = asVatId('v2');
const remote = asRemoteId('r0');
const ref = asRRef('ro-1');

/**
 * Make a kernel with an identity, and the issuer of its segments.
 *
 * @param seedByte - The byte its key seed is filled with.
 * @returns The kernel's store, signer, issuer, and peer ID.
 */
const makeIssuingKernel = async (
  seedByte: number,
): Promise<{
  kernelStore: KernelStore;
  signer: KernelSigner;
  issuer: SegmentIssuer;
  peerId: string;
}> => {
  const kdb = makeMapKernelDatabase();
  const peerId = await seedIdentity(kdb.kernelKVStore, seedByte);
  const kernelStore = makeKernelStore(kdb);
  const signer = makeKernelSigner({
    kernelStore,
    ensureIdentity: async () => undefined,
  });
  return {
    kernelStore,
    signer,
    issuer: makeSegmentIssuer({ kernelStore, signer }),
    peerId,
  };
};

describe('makeSegmentIssuer', () => {
  it("signs the kernel's chain of custody from the holder, under the ref the peer gets", async () => {
    const { kernelStore, issuer, peerId } = await makeIssuingKernel(1);
    const kref = kernelStore.initKernelObject(owner);
    kernelStore.recordConveyance({
      kref,
      sender: owner,
      to: holder,
      via: 'message',
      carrier: kref,
    });
    const [segment, ...rest] = await issuer.issue({ kref, ref, holder });
    expect(rest).toStrictEqual([]);
    expect(segment).toStrictEqual({
      payload: {
        kind: 'segment',
        ref,
        kref,
        owner,
        hops: [
          {
            endpoint: holder,
            parties: [],
            acquisitions: [
              expect.objectContaining({ kind: 'conveyance', sender: owner }),
            ],
          },
          { endpoint: owner, parties: [], acquisitions: [] },
        ],
      },
      signer: peerId,
      incarnationId: expect.any(String),
      signature: expect.any(String),
    });
    expect(await verifyKernelSignature(segment as Segment)).toBe(true);
  });

  it('names the kernel the object came from, and passes its segments on verbatim', async () => {
    const { kernelStore, issuer } = await makeIssuingKernel(1);
    kernelStore.setRemoteInfo(remote, { peerId: 'upstream-peer' });
    const kref = kernelStore.initKernelObject(remote);
    const upstream = {
      payload: { kind: 'segment', ref, kref: 'ko9', owner: 'v3', hops: [] },
      signer: 'upstream-peer',
      incarnationId: 'inc',
      signature: 'sig',
    } as unknown as Segment;
    kernelStore.setSegments(kref, [upstream]);
    const segments = await issuer.issue({ kref, ref, holder });
    expect(segments).toStrictEqual([
      expect.objectContaining({
        payload: expect.objectContaining({
          owner: remote,
          from: 'upstream-peer',
        }),
      }),
      upstream,
    ]);
  });

  it('names no kernel for an owner the store has no peer for, and sends no more than the limit', async () => {
    const { kernelStore, issuer } = await makeIssuingKernel(1);
    const kref = kernelStore.initKernelObject(remote);
    const upstream = Array.from({ length: MAX_SEGMENTS }, (_, index) => ({
      payload: {
        kind: 'segment',
        ref,
        kref: `ko${index}`,
        owner: 'v3',
        hops: [],
      },
      signer: `peer-${index}`,
      incarnationId: 'inc',
      signature: 'sig',
    })) as unknown as Segment[];
    kernelStore.setSegments(kref, upstream);
    const segments = await issuer.issue({ kref, ref, holder });
    expect(segments).toHaveLength(MAX_SEGMENTS);
    expect(segments[0]?.payload).not.toHaveProperty('from');
    expect(segments.slice(1)).toStrictEqual(
      upstream.slice(0, MAX_SEGMENTS - 1),
    );
  });
});

describe('verifySegments', () => {
  /**
   * A segment signed by a kernel.
   *
   * @param signer - The kernel's signer.
   * @param payload - What differs from a bare segment for `ref`.
   * @returns The segment.
   */
  const sign = async (
    signer: KernelSigner,
    payload: Partial<Segment['payload']> = {},
  ): Promise<Segment> =>
    signer.sign({
      kind: 'segment',
      ref,
      kref: asKRef('ko1'),
      owner,
      hops: [],
      ...payload,
    });

  it('keeps a list as far as each segment is signed by the kernel the one before names', async () => {
    const near = await makeIssuingKernel(1);
    const far = await makeIssuingKernel(2);
    const origin = await makeIssuingKernel(3);
    const chain = [
      await sign(near.signer, { from: far.peerId }),
      await sign(far.signer, { from: origin.peerId }),
      await sign(origin.signer),
    ];
    expect(
      await verifySegments({ segments: chain, peerId: near.peerId, ref }),
    ).toStrictEqual(chain);
    const skipped = [chain[0], chain[2]];
    expect(
      await verifySegments({ segments: skipped, peerId: near.peerId, ref }),
    ).toStrictEqual([chain[0]]);
    const forged = [chain[0], { ...chain[1], signature: chain[2]?.signature }];
    expect(
      await verifySegments({ segments: forged, peerId: near.peerId, ref }),
    ).toStrictEqual([chain[0]]);
  });

  it.each([
    [
      'is not the peer',
      async (signer: KernelSigner) => [await sign(signer)],
      'someone-else',
    ],
    [
      'names another ref',
      async (signer: KernelSigner) => [
        await sign(signer, { ref: asRRef('ro-2') }),
      ],
      undefined,
    ],
    [
      'does not check',
      async (signer: KernelSigner) => [
        { ...(await sign(signer)), signature: '00' },
      ],
      undefined,
    ],
    [
      'is malformed',
      async (signer: KernelSigner) => [
        { ...(await sign(signer)), payload: {} },
      ],
      undefined,
    ],
    ['is nothing', async () => 'segments', undefined],
    ['is empty', async () => [], undefined],
    [
      'is too long',
      async (signer: KernelSigner) =>
        Array(MAX_SEGMENTS + 1).fill(await sign(signer)),
      undefined,
    ],
  ])('keeps nothing when the first segment %s', async (_what, make, peerId) => {
    const { signer, peerId: own } = await makeIssuingKernel(1);
    expect(
      await verifySegments({
        segments: await make(signer),
        peerId: peerId ?? own,
        ref,
      }),
    ).toStrictEqual([]);
  });
});
