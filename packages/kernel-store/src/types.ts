export type KVStore = {
  get<Value extends string = string>(key: string): Value | undefined;
  getRequired<Value extends string = string>(key: string): Value;
  getNextKey(previousKey: string): string | undefined;
  set(key: string, value: string): void;
  delete(key: string): void;
};

export type KVPair = [string, string];

/**
 * A vat checkpoint is a tuple of two arrays describing the changes since the previous checkpoint:
 * - The first array contains updated key-value pairs.
 * - The second array contains deleted keys.
 */
export type VatCheckpoint = [KVPair[], string[]];

export type VatKVStore = KVStore & {
  checkpoint(): VatCheckpoint;
};

export type VatStore = {
  getKVData(): KVPair[];
  updateKVData(sets: KVPair[], deletes: string[]): void;
};

/**
 * A row of the accountability records table, where the kernel keeps what it
 * records: what it saw done with which object, by whom. Append-only, in the
 * order written. The columns other than `data` are the ones records are
 * looked up by, and `data` is the whole record as JSON.
 */
export type AccountabilityRecordRow = {
  seq: number;
  kind: string;
  /** The layer vouching for the record: the kernel, liveslots, or a vat. */
  witness: string;
  crank: number;
  kref: string | null;
  endpoint: string | null;
  sender: string | null;
  trace: string | null;
  data: string;
};

/** Which records to read or delete. Every condition given must hold. */
export type AccountabilityRecordFilter = {
  kind?: string;
  kref?: string;
  endpoint?: string;
  sender?: string;
  /** Rows whose endpoint or sender is this. */
  involving?: string;
  trace?: string;
  /** Rows written in cranks up to and including this one. */
  throughCrank?: number;
  /** Rows after this sequence number. */
  afterSeq?: number;
  limit?: number;
};

export type AccountabilityRecordStore = {
  /**
   * Append a record.
   *
   * @param row - The record, without its sequence number.
   * @returns The sequence number it was given.
   */
  append(row: Omit<AccountabilityRecordRow, 'seq'>): number;
  /**
   * Read records, in sequence order.
   *
   * @param filter - Which records; all of them if omitted.
   * @returns The records.
   */
  query(filter?: AccountabilityRecordFilter): AccountabilityRecordRow[];
  /**
   * Delete records.
   *
   * @param filter - Which records; all of them if omitted.
   * @returns How many were deleted.
   */
  delete(filter?: AccountabilityRecordFilter): number;
};

export type KernelDatabase = {
  kernelKVStore: KVStore;
  accountabilityRecords: AccountabilityRecordStore;
  executeQuery(sql: string): Record<string, string>[];
  clear(): void;
  makeVatStore(vatID: string): VatStore;
  deleteVatStore(vatID: string): void;
  createSavepoint(name: string): void;
  rollbackSavepoint(name: string): void;
  releaseSavepoint(name: string): void;
  close(): void;
};
