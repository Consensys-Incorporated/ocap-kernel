import { insistKRef } from '@metamask/ocap-kernel';
import type { KRef } from '@metamask/ocap-kernel';

import type {
  ObjectRegistry,
  VatSnapshot,
  SlotInfo,
  ExportedOcapURL,
} from '../types.ts';

/**
 * Parse a flat kernel DB dump into per-vat grouped info
 *
 * @param entries - The flat kernel DB dump.
 * @returns A record of vat names to their KernelGroupedVat info.
 */
export function parseObjectRegistry(
  entries: { key: string; value: string }[],
): ObjectRegistry {
  // Raw metadata
  const koOwner: Record<string, string> = {};
  const koRefCount: Record<string, string> = {};
  const koRevoked: Record<string, string> = {};
  const kpState: Record<string, string> = {};
  const kpValueRaw: Record<string, { body: string; slots: string[] }> = {};
  const vatConfigs: Record<string, { name: string; bundleSpec: string }> = {};
  // C-lists
  const objCList: { vat: string; kref: KRef; eref: string }[] = [];
  const prmCList: { vat: string; kref: KRef; eref: string }[] = [];

  let gcActions = '';
  let reapQueue = '';
  let terminatedVats = '';
  const ocapUrls: ExportedOcapURL[] = [];

  // 1) Collect
  for (const { key, value } of entries) {
    if (key === 'gcActions') {
      gcActions = value;
      continue;
    }
    if (key === 'reapQueue') {
      reapQueue = value;
      continue;
    }
    if (key === 'vats.terminated') {
      terminatedVats = value;
      continue;
    }
    if (key.startsWith('vatConfig.')) {
      const vat = key.split('.')[1] as string;
      const config = JSON.parse(value);
      vatConfigs[vat] = {
        name: config.parameters?.name ?? vat,
        bundleSpec: config.bundleSpec,
      };
      continue;
    }
    let matches;
    if ((matches = key.match(/^(ko\d+)\.owner$/u))) {
      matches[1] && (koOwner[matches[1]] = value);
      continue;
    }
    if ((matches = key.match(/^(ko\d+)\.refCount$/u))) {
      matches[1] && (koRefCount[matches[1]] = value);
      continue;
    }
    if ((matches = key.match(/^(ko\d+)\.revoked$/u))) {
      matches[1] && (koRevoked[matches[1]] = value);
      continue;
    }
    if ((matches = key.match(/^(kp\d+)\.state$/u))) {
      matches[1] && (kpState[matches[1]] = value);
      continue;
    }
    if ((matches = key.match(/^(kp\d+)\.value$/u))) {
      matches[1] && (kpValueRaw[matches[1]] = JSON.parse(value));
      continue;
    }
    if ((matches = key.match(/^(v\d+)\.c\.(ko\d+)$/u))) {
      matches[1] &&
        objCList.push({
          vat: matches[1],
          // Safe cast: regex capture group guarantees KRef format
          kref: matches[2] as KRef,
          eref: value.replace(/^R\s*/u, ''),
        });
      continue;
    }
    if ((matches = key.match(/^(v\d+)\.c\.(kp\d+)$/u))) {
      matches[1] &&
        prmCList.push({
          vat: matches[1],
          // Safe cast: regex capture group guarantees KRef format
          kref: matches[2] as KRef,
          eref: value.replace(/^R\s*/u, ''),
        });
      continue;
    }
  }

  // 2) Init vats
  const vats: Record<string, VatSnapshot> = {};
  for (const vat of Object.keys(vatConfigs)) {
    if (!vatConfigs[vat]) {
      continue;
    }
    vats[vat] = {
      overview: vatConfigs[vat],
      ownedObjects: [],
      importedObjects: [],
      importedPromises: [],
      exportedPromises: [],
    };
  }

  // Helper to resolve slots
  const resolveSlot = (kref: string): SlotInfo => {
    insistKRef(kref);
    const entry = objCList.find((item) => item.kref === kref);
    return {
      kref,
      eref: entry?.eref ?? null,
      vat: entry?.vat ?? null,
    };
  };

  // 3) Populate objects
  for (const { vat, kref, eref } of objCList) {
    const bucket = vats[vat];
    if (!bucket) {
      continue;
    }
    const rec = {
      kref,
      eref,
      refCount: koRefCount[kref] ?? '0',
    };
    if (eref.startsWith('o+')) {
      bucket.ownedObjects.push({
        ...rec,
        toVats: [],
        revoked: koRevoked[kref] ?? 'false',
      });
    } else {
      bucket.importedObjects.push({ ...rec, fromVat: koOwner[kref] ?? null });
    }
  }
  // Cross-link objects
  for (const vat of Object.keys(vats)) {
    for (const obj of vats[vat]?.ownedObjects ?? []) {
      obj.toVats = objCList
        .filter(
          (entry) =>
            entry.kref === obj.kref &&
            entry.vat !== vat &&
            entry.eref.startsWith('o-'),
        )
        .map((entry) => entry.vat);
    }
  }

  // 4) Populate promises
  for (const { vat, kref, eref } of prmCList) {
    const bucket = vats[vat];
    if (!bucket) {
      continue;
    }
    const raw = kpValueRaw[kref] ?? { body: '', slots: [] };
    const slots = raw.slots.map(resolveSlot);

    // Extract ocap URL if present in the promise body
    if (raw.body && typeof raw.body === 'string') {
      const ocapMatch = raw.body.match(/^#"(ocap:[^"]+)"/u);
      if (ocapMatch) {
        ocapUrls.push({
          vatId: vat,
          promiseId: kref,
          ocapUrl: ocapMatch[1] ?? '',
        });
      }
    }

    const base = {
      kref,
      eref,
      state: kpState[kref] ?? 'unresolved',
      value: { body: raw.body, slots },
    };
    if (eref.startsWith('p+')) {
      bucket.exportedPromises.push({ ...base, toVats: [] });
    } else {
      const origin =
        prmCList.find(
          (entry) =>
            entry.kref === kref &&
            entry.vat !== vat &&
            entry.eref.startsWith('p+'),
        )?.vat ?? null;
      bucket.importedPromises.push({ ...base, fromVat: origin });
    }
  }
  // Cross-link promises
  for (const vat of Object.keys(vats)) {
    for (const prm of vats[vat]?.exportedPromises ?? []) {
      prm.toVats = prmCList
        .filter(
          (entry) =>
            entry.kref === prm.kref &&
            entry.vat !== vat &&
            entry.eref.startsWith('p-'),
        )
        .map((entry) => entry.vat);
    }
  }

  return {
    gcActions,
    reapQueue,
    terminatedVats,
    vats,
    ocapUrls,
  };
}
