import { Logger } from '@metamask/logger';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import { SQL_QUERIES, DEFAULT_DB_FILENAME } from './common.ts';
import { getDBFolder } from './env.ts';
import { makeTransactionMethods } from './transactions.ts';
import type { KVStore, VatStore, KernelDatabase } from '../types.ts';

export type Database = SqliteDatabase & {
  // stack of active savepoint names
  _spStack: string[];
};

/**
 * Ensure that SQLite is initialized.
 *
 * @param dbFilename - The filename of the database to use.
 * @param logger - The logger to use, if any.
 * @returns The SQLite database object.
 */
async function initDB(dbFilename: string, logger?: Logger): Promise<Database> {
  const dbPath = await getDBFilename(dbFilename);
  logger?.debug('dbPath:', dbPath);
  const db = new Sqlite(dbPath, {
    verbose: (logger ? logger.info.bind(logger) : undefined) as
      | ((...args: unknown[]) => void)
      | undefined,
  }) as Database;
  db._spStack = [];
  return db;
}

/**
 * Makes a persistent {@link KVStore} on top of a SQLite database.
 *
 * @param db - The (open) database to use.
 * @param options - Options for the store.
 * @param options.assertWritable - Throws if this connection can no longer
 * persist anything, which every write here must ask first: one issued into a
 * transaction nothing can end reports success and is lost with it.
 * @returns A key/value store using the given database.
 */
function makeKVStore(
  db: Database,
  { assertWritable }: { assertWritable: () => void },
): KVStore {
  const sqlKVInit = db.prepare(SQL_QUERIES.CREATE_TABLE);
  sqlKVInit.run();

  const sqlKVGet = db.prepare<[string], string>(SQL_QUERIES.GET);
  sqlKVGet.pluck(true);

  /**
   * Read a key's value from the database.
   *
   * @param key - A key to fetch.
   * @param required - True if it is an error for the entry not to be there.
   * @returns The value at that key.
   */
  function kvGet(key: string, required: boolean): string | undefined {
    const result = sqlKVGet.get(key);
    if (required && !result) {
      throw Error(`no record matching key '${key}'`);
    }
    return result;
  }

  const sqlKVGetNextKey = db.prepare(SQL_QUERIES.GET_NEXT);
  sqlKVGetNextKey.pluck(true);

  /**
   * Get the lexicographically next key in the KV store after a given key.
   *
   * @param previousKey - The key you want to know the key after.
   *
   * @returns The key after `previousKey`, or undefined if `previousKey` is the
   *   last key in the store.
   */
  function kvGetNextKey(previousKey: string): string | undefined {
    if (typeof previousKey !== 'string') {
      // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
      throw new Error(`previousKey ${previousKey} must be a string`);
    }
    return sqlKVGetNextKey.get(previousKey) as string | undefined;
  }

  const sqlKVSet = db.prepare(SQL_QUERIES.SET);

  /**
   * Set the value associated with a key in the database.
   *
   * @param key - A key to assign.
   * @param value - The value to assign to it.
   */
  function kvSet(key: string, value: string): void {
    assertWritable();
    sqlKVSet.run(key, value);
  }

  const sqlKVDelete = db.prepare(SQL_QUERIES.DELETE);

  /**
   * Delete a key from the database.
   *
   * @param key - The key to remove.
   */
  function kvDelete(key: string): void {
    assertWritable();
    sqlKVDelete.run(key);
  }

  return {
    get: <Value extends string = string>(key: string) =>
      kvGet(key, false) as Value | undefined,
    getNextKey: kvGetNextKey,
    getRequired: <Value extends string = string>(key: string) =>
      kvGet(key, true) as Value,
    set: kvSet,
    delete: kvDelete,
  };
}

/**
 * Makes a {@link KernelDatabase} for low-level persistent storage.
 *
 * @param options - The options for the database.
 * @param options.dbFilename - The filename of the database to use. Defaults to {@link DEFAULT_DB_FILENAME}.
 * @param options.logger - A logger to use.
 * @returns The key/value store to base the kernel store on.
 */
export async function makeSQLKernelDatabase({
  dbFilename,
  logger,
}: {
  dbFilename?: string | undefined;
  logger?: Logger;
}): Promise<KernelDatabase> {
  const db = await initDB(dbFilename ?? DEFAULT_DB_FILENAME, logger);

  const sqlBeginTransaction = db.prepare(SQL_QUERIES.BEGIN_TRANSACTION);
  const sqlCommitTransaction = db.prepare(SQL_QUERIES.COMMIT_TRANSACTION);
  const sqlAbortTransaction = db.prepare(SQL_QUERIES.ABORT_TRANSACTION);

  const {
    assertNotAbandoned,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
  } = makeTransactionMethods({
    db,
    begin: () => sqlBeginTransaction.run(),
    commit: () => sqlCommitTransaction.run(),
    abort: () => sqlAbortTransaction.run(),
    logger,
  });

  const kvStore = makeKVStore(db, { assertWritable: assertNotAbandoned });

  const sqlKVInitVS = db.prepare(SQL_QUERIES.CREATE_TABLE_VS);
  sqlKVInitVS.run();

  const sqlKVClear = db.prepare(SQL_QUERIES.CLEAR);
  const sqlKVClearVS = db.prepare(SQL_QUERIES.CLEAR_VS);
  const sqlVatstoreGetAll = db.prepare(SQL_QUERIES.GET_ALL_VS);
  const sqlVatstoreSet = db.prepare(SQL_QUERIES.SET_VS);
  const sqlVatstoreDelete = db.prepare(SQL_QUERIES.DELETE_VS);
  const sqlVatstoreDeleteAll = db.prepare(SQL_QUERIES.DELETE_VS_ALL);

  /**
   * Delete everything from the database.
   */
  function kvClear(): void {
    sqlKVClear.run();
    sqlKVClearVS.run();
  }

  const kvClearInTransaction = db.transaction(kvClear);

  /**
   * Delete everything from the database, refusing rather than handing the
   * deletes to a transaction that will never commit.
   */
  function clear(): void {
    assertNotAbandoned();
    kvClearInTransaction();
  }

  /**
   * Execute an arbitrary query and return the results.
   *
   * @param sql - The query to execute.
   * @returns The results
   */
  function kvExecuteQuery(sql: string): Record<string, string>[] {
    const query = db.prepare(sql);
    return query.all() as Record<string, string>[];
  }

  /**
   * Create a new VatStore for a vat.
   *
   * @param vatID - The vat for which this is being done.
   *
   * @returns a a VatStore object for the given vat.
   */
  function makeVatStore(vatID: string): VatStore {
    /**
     * Fetch all the data in the vatstore.
     *
     * @returns the vatstore contents as a key-value Map.
     */
    function getKVData(): [string, string][] {
      const result: [string, string][] = [];
      type KVPair = {
        key: string;
        value: string;
      };
      for (const kvPair of sqlVatstoreGetAll.iterate(vatID)) {
        const { key, value } = kvPair as KVPair;
        result.push([key, value]);
      }
      return result;
    }

    /**
     * Update the state of the vatstore
     *
     * @param sets - A map of key values that have been changed.
     * @param deletes - A set of keys that have been deleted.
     */
    function updateKVData(sets: [string, string][], deletes: string[]): void {
      assertNotAbandoned();
      db.transaction(() => {
        for (const [key, value] of sets) {
          sqlVatstoreSet.run(vatID, key, value);
        }
        for (const value of deletes) {
          sqlVatstoreDelete.run(vatID, value);
        }
      })();
    }

    return {
      getKVData,
      updateKVData,
    };
  }

  /**
   * Delete an entire VatStore.
   *
   * @param vatId - The vat whose store is to be deleted.
   */
  function deleteVatStore(vatId: string): void {
    assertNotAbandoned();
    sqlVatstoreDeleteAll.run(vatId);
  }

  return {
    kernelKVStore: kvStore,
    executeQuery: kvExecuteQuery,
    clear,
    makeVatStore,
    deleteVatStore,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
    close: () => db.close(),
  };
}

/**
 * Get the filename for a database.
 *
 * @param label - A label for the database.
 * @returns The filename for the database.
 */
export async function getDBFilename(label: string): Promise<string> {
  if (label.startsWith(':')) {
    return label;
  }
  if (isAbsolute(label)) {
    await mkdir(dirname(label), { recursive: true });
    return label;
  }
  const dbRoot = join(tmpdir(), './ocap-sqlite', getDBFolder());
  await mkdir(dbRoot, { recursive: true });
  return join(dbRoot, label);
}
