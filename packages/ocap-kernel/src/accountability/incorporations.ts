import type { VatCheckpoint, VatStore } from '@metamask/kernel-store';

import type { KernelStore } from '../store/index.ts';
import type { ERef, VatId } from '../types.ts';

/** The vatstore key under which liveslots keeps a durable object's state. */
const STATE_PREFIX = 'vom.';
const DURABLE_STATE_PREFIX = `${STATE_PREFIX}o+d`;

/**
 * The references in a durable object's state, as liveslots keeps it: a
 * record of each property's serialized value.
 *
 * @param state - The state, as stored.
 * @returns The references, each once; none for a state that is not of that
 * shape.
 */
function slotsOfState(state: string | undefined): Set<string> {
  const slots = new Set<string>();
  if (state === undefined) {
    return slots;
  }
  let properties: unknown;
  try {
    properties = JSON.parse(state);
  } catch {
    return slots;
  }
  if (typeof properties !== 'object' || properties === null) {
    return slots;
  }
  for (const value of Object.values(properties)) {
    const candidates = (value as { slots?: unknown } | null)?.slots;
    if (Array.isArray(candidates)) {
      for (const slot of candidates) {
        if (typeof slot === 'string') {
          slots.add(slot);
        }
      }
    }
  }
  return slots;
}

/**
 * Record each tracked object a delivery newly wrote into the state of one of
 * the vat's durable objects. Read from the state writes the delivery
 * returned, before they are applied, against the state as it was.
 *
 * @param options - Options bag.
 * @param options.kernelStore - The kernel's store.
 * @param options.vatStore - The vat's store, as it was before the delivery.
 * @param options.vatId - The vat.
 * @param options.sets - The state writes the delivery returned.
 */
export function recordIncorporations({
  kernelStore,
  vatStore,
  vatId,
  sets,
}: {
  kernelStore: KernelStore;
  vatStore: VatStore;
  vatId: VatId;
  sets: VatCheckpoint[0];
}): void {
  for (const [key, value] of sets) {
    if (!key.startsWith(DURABLE_STATE_PREFIX)) {
      continue;
    }
    const written = slotsOfState(value);
    if (written.size === 0) {
      continue;
    }
    const object = key.slice(STATE_PREFIX.length) as ERef;
    let before: Set<string> | undefined;
    for (const vref of written) {
      const kref = kernelStore.erefToKref(vatId, vref as ERef);
      if (kref === undefined || !kernelStore.isTracked(kref)) {
        continue;
      }
      before ??= slotsOfState(vatStore.getKVValue(key));
      if (before.has(vref)) {
        continue;
      }
      const objectKref = kernelStore.erefToKref(vatId, object);
      kernelStore.recordIncorporation({
        kref,
        endpoint: vatId,
        object,
        ...(objectKref === undefined ? {} : { objectKref }),
      });
    }
  }
}
harden(recordIncorporations);
