import type { KRef, SubclusterId, VatId } from '@metamask/ocap-kernel';

export type VatRecord = {
  id: VatId;
  source: string;
  parameters: string;
  creationOptions: string;
  subclusterId: SubclusterId;
};

/**
 * A snapshot of the entire running cluster, keyed by Vat ID
 */
export type ObjectRegistry = {
  gcActions: string;
  reapQueue: string;
  terminatedVats: string;
  vats: Record<string, VatSnapshot>;
  ocapUrls: ExportedOcapURL[];
};

export type ExportedOcapURL = {
  vatId: string;
  promiseId: string;
  ocapUrl: string;
};

/**
 * The full state and bindings for a single Vat
 */
export type VatSnapshot = {
  overview: { name: string; bundleSpec: string };
  ownedObjects: ObjectBindingWithTargets[];
  importedObjects: ObjectBindingWithSource[];
  importedPromises: PromiseBindingWithSource[];
  exportedPromises: PromiseBindingWithTargets[];
};

export type ObjectBinding = {
  kref: KRef;
  eref: string;
  refCount: string;
};

export type ObjectBindingWithSource = {
  fromVat: string | null;
} & ObjectBinding;

export type ObjectBindingWithTargets = {
  toVats: string[];
  revoked: string;
} & ObjectBinding;

export type PromiseBinding = {
  kref: KRef;
  eref: string;
  state: string;
  value: { body: string; slots: SlotInfo[] };
};

export type PromiseBindingWithSource = {
  fromVat: string | null;
} & PromiseBinding;

export type PromiseBindingWithTargets = {
  toVats: string[];
} & PromiseBinding;

export type SlotInfo = {
  kref: KRef;
  eref: string | null;
  vat: string | null;
};
