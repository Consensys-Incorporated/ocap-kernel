import { Logger } from '@metamask/logger';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import Sqlite from 'better-sqlite3';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';

import {
  SQL_QUERIES,
  DEFAULT_DB_FILENAME,
  assertSafeIdentifier,
} from './common.ts';
import { getDBFolder } from './env.ts';
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
 * @returns A key/value store using the given database.
 */
function makeKVStore(db: Database): KVStore {
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
    sqlKVSet.run(key, value);
  }

  const sqlKVDelete = db.prepare(SQL_QUERIES.DELETE);

  /**
   * Delete a key from the database.
   *
   * @param key - The key to remove.
   */
  function kvDelete(key: string): void {
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

  const kvStore = makeKVStore(db);

  const sqlKVInitVS = db.prepare(SQL_QUERIES.CREATE_TABLE_VS);
  sqlKVInitVS.run();

  const sqlKVClear = db.prepare(SQL_QUERIES.CLEAR);
  const sqlKVClearVS = db.prepare(SQL_QUERIES.CLEAR_VS);
  const sqlVatstoreGetAll = db.prepare(SQL_QUERIES.GET_ALL_VS);
  const sqlVatstoreSet = db.prepare(SQL_QUERIES.SET_VS);
  const sqlVatstoreDelete = db.prepare(SQL_QUERIES.DELETE_VS);
  const sqlVatstoreDeleteAll = db.prepare(SQL_QUERIES.DELETE_VS_ALL);
  const sqlBeginTransaction = db.prepare(SQL_QUERIES.BEGIN_TRANSACTION);
  const sqlCommitTransaction = db.prepare(SQL_QUERIES.COMMIT_TRANSACTION);
  const sqlAbortTransaction = db.prepare(SQL_QUERIES.ABORT_TRANSACTION);

  /**
   * Begin a transaction if not already in one
   *
   *  @returns True if a new transaction was started, false if already in one
   */
  function beginIfNeeded(): boolean {
    if (db.inTransaction) {
      return false;
    }
    sqlBeginTransaction.run();
    return true;
  }

  /**
   * Commit a transaction if one is active and no savepoints remain
   */
  function commitIfNeeded(): void {
    if (db.inTransaction && db._spStack.length === 0) {
      sqlCommitTransaction.run();
    }
  }

  /**
   * Rollback a transaction
   */
  function rollbackIfNeeded(): void {
    if (db.inTransaction) {
      sqlAbortTransaction.run();
      db._spStack.length = 0;
    }
  }

  /**
   * Delete everything from the database.
   */
  function kvClear(): void {
    sqlKVClear.run();
    sqlKVClearVS.run();
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
    sqlVatstoreDeleteAll.run(vatId);
  }

  /**
   * Create a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function createSavepoint(name: string): void {
    // We must be in a transaction when creating the savepoint or releasing it
    // later will cause an autocommit.
    // See https://github.com/Agoric/agoric-sdk/issues/8423
    beginIfNeeded();
    assertSafeIdentifier(name);
    const query = SQL_QUERIES.CREATE_SAVEPOINT.replace('%NAME%', name);
    db.exec(query);
    db._spStack.push(name);
  }

  /**
   * Rollback to a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function rollbackSavepoint(name: string): void {
    assertSafeIdentifier(name);
    const idx = db._spStack.lastIndexOf(name);
    if (idx < 0) {
      throw new Error(`No such savepoint: ${name}`);
    }
    const query = SQL_QUERIES.ROLLBACK_SAVEPOINT.replace('%NAME%', name);
    try {
      db.exec(query);
    } catch (error) {
      // Left as it was, the savepoint stays on the stack and the transaction open
      // with nothing to ever commit or abort it, so every later write on this
      // connection joins it, reports success, and vanishes on close. Discarding
      // the whole transaction is safe: it begins with the outermost savepoint, so
      // it holds only what this rollback was abandoning anyway.
      db._spStack.length = 0;
      try {
        rollbackIfNeeded();
      } catch (abortError) {
        // The rollback failure below is the one worth reporting, but a failed
        // abort leaves SQLite holding a transaction the next crank would
        // silently write into. Nothing here can repair that.
        logger?.error(
          'failed to discard transaction after rollback',
          abortError,
        );
      }
      throw error;
    }
    db._spStack.splice(idx);
    if (db._spStack.length === 0) {
      rollbackIfNeeded();
    }
  }

  /**
   * Release a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function releaseSavepoint(name: string): void {
    assertSafeIdentifier(name);
    const idx = db._spStack.lastIndexOf(name);
    if (idx < 0) {
      throw new Error(`No such savepoint: ${name}`);
    }
    const query = SQL_QUERIES.RELEASE_SAVEPOINT.replace('%NAME%', name);
    try {
      db.exec(query);
    } catch (error) {
      // The hazard `rollbackSavepoint` guards against, by the other door: left as
      // it was, the savepoint stays on the stack and the transaction open with
      // nothing to ever commit or abort it, so every later write on this
      // connection joins it, reports success, and vanishes on close. There is no
      // committing this transaction now, so discard it.
      db._spStack.length = 0;
      try {
        rollbackIfNeeded();
      } catch (abortError) {
        // The release failure below is the one worth reporting, but a failed
        // abort leaves SQLite holding a transaction the next crank would
        // silently write into. Nothing here can repair that.
        logger?.error(
          'failed to discard transaction after release',
          abortError,
        );
      }
      throw error;
    }
    db._spStack.splice(idx);
    if (db._spStack.length === 0) {
      commitIfNeeded();
    }
  }

  return {
    kernelKVStore: kvStore,
    executeQuery: kvExecuteQuery,
    clear: db.transaction(kvClear),
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
