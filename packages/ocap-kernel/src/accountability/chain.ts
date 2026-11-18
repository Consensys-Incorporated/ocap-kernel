import type {
  ConveyanceRecord,
  IntroductionRecord,
  PartyRef,
  StoredAttestation,
} from './types.ts';
import type { KernelStore } from '../store/index.ts';
import { isRemoteId, isVatId } from '../types.ts';
import type { KRef, Sender } from '../types.ts';

/** One way an endpoint came to hold an object. */
export type Acquisition = {
  kind: 'conveyance' | 'introduction';
  /** Who handed it over; null for an ocap URL redemption. */
  sender: Sender | null;
  via: IntroductionRecord['via'];
  crankNumber: number;
  /** The record this is read from. */
  seq: number;
};

/** A holder of an object, how it came to hold it, and who answers for it. */
export type ChainHop = {
  endpoint: Sender;
  parties: PartyRef[];
  /** Empty for the owner, and for the kernel, which holds what its host gives it. */
  acquisitions: Acquisition[];
};

/**
 * A chain of custody: the holders of an object from one holder back to its
 * owner, each resolved to the parties answerable for it. A graph rather
 * than a path where a holder was given the object by several senders.
 */
export type Chain = {
  kref: KRef;
  owner: Sender;
  /** From the holder asked about, in the order reached. */
  hops: ChainHop[];
};

/**
 * Resolve an endpoint to the parties answerable for it: for a vat, this
 * kernel's operator and the implementer of its bundle; for a remote, the
 * operator of that kernel; for the kernel itself, its operator.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.endpoint - The endpoint.
 * @param options.peerId - This kernel's peer ID, if it has one.
 * @returns The parties, each once.
 */
export function resolveParties({
  kernelStore,
  endpoint,
  peerId,
}: {
  kernelStore: KernelStore;
  endpoint: Sender;
  peerId: string | undefined;
}): PartyRef[] {
  const partiesOf = (
    kind: StoredAttestation['kind'],
    subject: string | undefined,
  ): PartyRef[] =>
    subject === undefined
      ? []
      : kernelStore
          .getAttestations({ kind, subject })
          .map(({ party }) => party);
  const parties: PartyRef[] = [];
  if (isVatId(endpoint)) {
    parties.push(
      ...partiesOf('operator', peerId),
      ...partiesOf('implementer', kernelStore.getVatBundleHash(endpoint)),
    );
  } else if (isRemoteId(endpoint)) {
    let remotePeerId: string | undefined;
    try {
      remotePeerId = kernelStore.getRemoteInfo(endpoint).peerId;
    } catch {
      remotePeerId = undefined;
    }
    parties.push(...partiesOf('operator', remotePeerId));
  } else {
    parties.push(...partiesOf('operator', peerId));
  }
  return [...new Set(parties)];
}

/**
 * Build a holder's chain of custody for an object: the conveyances of the
 * object to the holder, or failing those its introduction, each naming a
 * sender; the same for each sender in turn; and so on back to the owner.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.kref - The object.
 * @param options.holder - The holder to start from.
 * @param options.peerId - This kernel's peer ID, if it has one.
 * @returns The chain.
 */
export function buildChain({
  kernelStore,
  kref,
  holder,
  peerId,
}: {
  kernelStore: KernelStore;
  kref: KRef;
  holder: Sender;
  peerId: string | undefined;
}): Chain {
  const owner = kernelStore.getOwner(kref) ?? 'kernel';
  const hops: ChainHop[] = [];
  const visited = new Set<Sender>();
  const pending: Sender[] = [holder];
  while (pending.length > 0) {
    const endpoint = pending.shift() as Sender;
    if (visited.has(endpoint)) {
      continue;
    }
    visited.add(endpoint);
    const acquisitions =
      endpoint === owner || endpoint === 'kernel'
        ? []
        : acquisitionsOf(kernelStore, kref, endpoint);
    hops.push({
      endpoint,
      parties: resolveParties({ kernelStore, endpoint, peerId }),
      acquisitions,
    });
    for (const { sender } of acquisitions) {
      if (sender !== null && !visited.has(sender)) {
        pending.push(sender);
      }
    }
  }
  return { kref, owner, hops };
}

/**
 * How an endpoint came to hold an object: every conveyance of it to the
 * endpoint, or failing those its introduction.
 *
 * @param kernelStore - The kernel's store.
 * @param kref - The object.
 * @param endpoint - The holder.
 * @returns The acquisitions, in the order recorded.
 */
function acquisitionsOf(
  kernelStore: KernelStore,
  kref: KRef,
  endpoint: Sender,
): Acquisition[] {
  const conveyances = kernelStore.getAccountabilityRecords({
    kind: 'conveyance',
    kref,
    endpoint,
  }) as ConveyanceRecord[];
  if (conveyances.length > 0) {
    return conveyances.map(({ sender, via, crankNumber, seq }) => ({
      kind: 'conveyance',
      sender,
      via,
      crankNumber,
      seq,
    }));
  }
  const introductions = kernelStore.getAccountabilityRecords({
    kind: 'introduction',
    kref,
    endpoint,
  }) as IntroductionRecord[];
  return introductions.map(({ sender, via, crankNumber, seq }) => ({
    kind: 'introduction',
    sender,
    via,
    crankNumber,
    seq,
  }));
}
