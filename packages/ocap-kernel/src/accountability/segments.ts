import {
  array,
  exactOptional,
  integer,
  is,
  literal,
  nullable,
  object,
  size,
  string,
  union,
} from '@metamask/superstruct';

import { buildChain } from './chain.ts';
import type { Custody } from './chain.ts';
import { verifyKernelSignature } from './signing.ts';
import type { KernelSigner, Signed } from './signing.ts';
import { PartyRefStruct } from './types.ts';
import type { KernelStore } from '../store/index.ts';
import { isRemoteId } from '../types.ts';
import type { ERef, KRef, Sender } from '../types.ts';

/** The most segments a reference may carry, here or from a peer. */
export const MAX_SEGMENTS = 64;

/**
 * What a kernel signs when it exports a tracked object to a peer: its own
 * chain of custody for the object, from the endpoint exporting it back to
 * its owner, named by the reference the peer receives it under. Where the
 * owner is itself a remote, `from` names that kernel, whose segment should
 * be the next in the list the peer receives.
 */
export type SegmentPayload = Custody & {
  kind: 'segment';
  ref: ERef;
  from?: string;
};

export type Segment = Signed<SegmentPayload>;

const AcquisitionStruct = object({
  kind: union([literal('conveyance'), literal('introduction')]),
  sender: nullable(string()),
  via: union([
    literal('message'),
    literal('notify'),
    literal('ocap-url'),
    literal('unknown'),
  ]),
  seq: integer(),
});

const ChainHopStruct = object({
  endpoint: string(),
  parties: array(PartyRefStruct),
  acquisitions: array(AcquisitionStruct),
});

export const SegmentStruct = object({
  payload: object({
    kind: literal('segment'),
    ref: string(),
    kref: string(),
    owner: string(),
    hops: array(ChainHopStruct),
    from: exactOptional(string()),
  }),
  signer: string(),
  incarnationId: string(),
  signature: string(),
});

const SegmentsStruct = size(array(SegmentStruct), 1, MAX_SEGMENTS);

export type SegmentIssuer = {
  /**
   * The segments to send with an object: this kernel's own, signed now,
   * followed by those it received with the object, verbatim.
   */
  issue(options: { kref: KRef; ref: ERef; holder: Sender }): Promise<Segment[]>;
};

/**
 * Make the issuer of this kernel's segments.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.signer - The kernel's signer.
 * @returns The issuer.
 */
export function makeSegmentIssuer({
  kernelStore,
  signer,
}: {
  kernelStore: KernelStore;
  signer: KernelSigner;
}): SegmentIssuer {
  return harden({
    async issue({
      kref,
      ref,
      holder,
    }: {
      kref: KRef;
      ref: ERef;
      holder: Sender;
    }): Promise<Segment[]> {
      const peerId = await signer.getPeerId();
      const { owner, hops, segments } = buildChain({
        kernelStore,
        kref,
        holder,
        peerId,
      });
      let from: string | undefined;
      if (isRemoteId(owner)) {
        try {
          from = kernelStore.getRemoteInfo(owner).peerId;
        } catch {
          from = undefined;
        }
      }
      const own = await signer.sign<SegmentPayload>({
        kind: 'segment',
        ref,
        kref,
        owner,
        hops,
        ...(from === undefined ? {} : { from }),
      });
      return harden([own, ...segments.slice(0, MAX_SEGMENTS - 1)]);
    },
  });
}

/**
 * Check the segments a peer sent with an object: the first must be the
 * peer's own and name the reference the object came under, and each must
 * be signed by the kernel the one before it names. The list is taken as
 * far as it checks.
 *
 * @param options - Options bag.
 * @param options.segments - What the peer sent.
 * @param options.peerId - The peer's ID.
 * @param options.ref - The reference the object came under.
 * @returns The segments that check, in order; none if the first does not.
 */
export async function verifySegments({
  segments,
  peerId,
  ref,
}: {
  segments: unknown;
  peerId: string;
  ref: ERef;
}): Promise<Segment[]> {
  if (!is(segments, SegmentsStruct)) {
    return harden([]);
  }
  const verified: Segment[] = [];
  for (const segment of segments) {
    const expectedSigner =
      verified.length === 0 ? peerId : verified.at(-1)?.payload.from;
    if (
      segment.signer !== expectedSigner ||
      (verified.length === 0 && segment.payload.ref !== ref) ||
      !(await verifyKernelSignature(segment))
    ) {
      break;
    }
    verified.push(segment as Segment);
  }
  return harden(verified);
}
