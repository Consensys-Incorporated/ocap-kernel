import { Logger } from '@metamask/logger';
import type {
  Database as SqliteDatabase,
  Sqlite3Static,
} from '@sqlite.org/sqlite-wasm';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';

import { DEFAULT_DB_FILENAME, SQL_QUERIES } from './common.ts';
import { getDBFolder } from './env.ts';
import { makeTransactionMethods } from './transactions.ts';
import type { KVStore, VatStore, KernelDatabase } from '../types.ts';

export type Database = SqliteDatabase & {
  /**
   * A cached answer goes stale: SQLite ends the transaction itself after
   * SQLITE_FULL, SQLITE_IOERR or SQLITE_BUSY, and a driver still believing one
   * is open skips the next `BEGIN` and then cannot commit.
   */
  readonly inTransaction: boolean;
  // stack of active savepoint names
  _spStack: string[];
};

/** `sqlite3_get_autocommit` is bound by the wasm build but absent from its types. */
type AutocommitCapi = { sqlite3_get_autocommit: (pDb: number) => number };

type PreparedStatement = { step: () => unknown; reset: () => unknown };

/**
 * Ensure that SQLite is initialized.
 *
 * @param dbFilename - The filename of the database to use.
 * @param logger - The logger to use, if any.
 * @returns The SQLite database object.
 */
export async function initDB(
  dbFilename: string,
  logger?: Logger,
): Promise<Database> {
  const sqlite3 = await sqlite3InitModule();
  const { sqlite3_get_autocommit: getAutocommit } =
    sqlite3.capi as Sqlite3Static['capi'] & AutocommitCapi;
  if (typeof getAutocommit !== 'function') {
    throw Error('sqlite3 capi lacks sqlite3_get_autocommit');
  }

  let db: SqliteDatabase;

  if (sqlite3.oo1.OpfsDb) {
    const dbName = dbFilename.startsWith(':')
      ? dbFilename
      : ['ocap', getDBFolder(), dbFilename].filter(Boolean).join('-');
    db = new sqlite3.oo1.OpfsDb(dbName, 'cw');
  } else {
    logger?.warn(`OPFS not enabled, database will be ephemeral`);
    db = new sqlite3.oo1.DB(`:memory:`, 'cw');
  }

  const dbWithTx = db as Database;
  Object.defineProperty(dbWithTx, 'inTransaction', {
    get: () =>
      dbWithTx.pointer !== undefined && getAutocommit(dbWithTx.pointer) === 0,
  });
  dbWithTx._spStack = [];

  return dbWithTx;
}

/**
 * Makes a {@link KVStore} on top of a SQLite database
 *
 * @param db - The (open) database to use.
 * @param logger - A logger object for recording activity.
 * @returns A key/value store using the given database.
 */
function makeKVStore(db: Database, logger?: Logger): KVStore {
  db.exec(SQL_QUERIES.CREATE_TABLE);

  const sqlKVGet = db.prepare(SQL_QUERIES.GET);

  /**
   * Read a key's value from the database.
   *
   * @param key - A key to fetch.
   * @param required - True if it is an error for the entry not to be there.
   * @returns The value at that key.
   */
  function kvGet(key: string, required: boolean): string | undefined {
    sqlKVGet.bind([key]);
    if (sqlKVGet.step()) {
      const result = sqlKVGet.getString(0);
      if (result) {
        sqlKVGet.reset();
        logger?.debug(`kv get '${key}' as '${result}'`);
        return result;
      }
    }
    sqlKVGet.reset();
    if (required) {
      throw Error(`no record matching key '${key}'`);
    }
    return undefined;
  }

  const sqlKVGetNextKey = db.prepare(SQL_QUERIES.GET_NEXT);

  /**
   * Get the lexicographically next key in the KV store after a given key.
   *
   * @param previousKey - The key you want to know the key after.
   *
   * @returns The key after `previousKey`, or undefined if `previousKey` is the
   *   last key in the store.
   */
  function kvGetNextKey(previousKey: string): string | undefined {
    sqlKVGetNextKey.bind([previousKey]);
    if (sqlKVGetNextKey.step()) {
      const result = sqlKVGetNextKey.getString(0);
      if (result) {
        sqlKVGetNextKey.reset();
        logger?.debug(`kv getNextKey '${previousKey}' as '${result}'`);
        return result;
      }
    }
    sqlKVGetNextKey.reset();
    return undefined;
  }

  const sqlKVSet = db.prepare(SQL_QUERIES.SET);

  /**
   * Set the value associated with a key in the database.
   *
   * @param key - A key to assign.
   * @param value - The value to assign to it.
   */
  function kvSet(key: string, value: string): void {
    logger?.debug(`kv set '${key}' to '${value}'`);
    sqlKVSet.bind([key, value]);
    sqlKVSet.step();
    sqlKVSet.reset();
  }

  const sqlKVDelete = db.prepare(SQL_QUERIES.DELETE);

  /**
   * Delete a key from the database.
   *
   * @param key - The key to remove.
   */
  function kvDelete(key: string): void {
    logger?.debug(`kv delete '${key}'`);
    sqlKVDelete.bind([key]);
    sqlKVDelete.step();
    sqlKVDelete.reset();
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
 * @returns A key/value store to base higher level stores on.
 */
export async function makeSQLKernelDatabase({
  dbFilename,
  logger,
}: {
  dbFilename?: string | undefined;
  logger?: Logger;
}): Promise<KernelDatabase> {
  const db = await initDB(dbFilename ?? DEFAULT_DB_FILENAME, logger);

  logger?.debug('Initializing kernel store');
  const kvStore = makeKVStore(db, logger?.subLogger({ tags: ['kv'] }));

  db.exec(SQL_QUERIES.CREATE_TABLE_VS);

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
   * Step and reset a prepared statement.
   *
   * @param statement - The statement to run.
   */
  function runStatement(statement: PreparedStatement): void {
    statement.step();
    statement.reset();
  }

  const {
    beginIfNeeded,
    commitIfNeeded,
    rollbackIfNeeded,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
  } = makeTransactionMethods({
    db,
    begin: () => runStatement(sqlBeginTransaction),
    commit: () => runStatement(sqlCommitTransaction),
    abort: () => runStatement(sqlAbortTransaction),
  });

  /**
   * Safely mutate the database with proper transaction management
   *
   * @param mutator - Function that performs the database mutations
   */
  function safeMutate(mutator: () => void): void {
    const startedTx = beginIfNeeded();
    try {
      mutator();
      if (startedTx) {
        commitIfNeeded();
      }
    } catch (error) {
      if (startedTx) {
        rollbackIfNeeded();
      }
      throw error;
    }
  }

  /**
   * Delete everything from the database.
   */
  function kvClear(): void {
    logger?.debug('clearing all kernel state');
    sqlKVClear.step();
    sqlKVClear.reset();
    sqlKVClearVS.step();
    sqlKVClearVS.reset();
  }

  /**
   * Execute a SQL query.
   *
   * @param sql - The SQL query to execute.
   * @returns An array of results.
   */
  function executeQuery(sql: string): Record<string, string>[] {
    const stmt = db.prepare(sql);
    const results: Record<string, string>[] = [];
    try {
      const { columnCount } = stmt;
      while (stmt.step()) {
        const row: Record<string, string> = {};
        for (let i = 0; i < columnCount; i++) {
          const columnName = stmt.getColumnName(i);
          if (columnName) {
            row[columnName] = String(stmt.get(i) as string);
          }
        }
        results.push(row);
      }
    } finally {
      stmt.reset();
    }
    return results;
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
      sqlVatstoreGetAll.bind([vatID]);
      try {
        while (sqlVatstoreGetAll.step()) {
          const key = sqlVatstoreGetAll.getString(0) as string;
          const value = sqlVatstoreGetAll.getString(1) as string;
          result.push([key, value]);
        }
      } finally {
        sqlVatstoreGetAll.reset();
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
      safeMutate(() => {
        for (const [key, value] of sets) {
          sqlVatstoreSet.bind([vatID, key, value]);
          sqlVatstoreSet.step();
          sqlVatstoreSet.reset();
        }
        for (const value of deletes) {
          sqlVatstoreDelete.bind([vatID, value]);
          sqlVatstoreDelete.step();
          sqlVatstoreDelete.reset();
        }
      });
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
    sqlVatstoreDeleteAll.bind([vatId]);
    sqlVatstoreDeleteAll.step();
    sqlVatstoreDeleteAll.reset();
  }

  return {
    kernelKVStore: kvStore,
    clear: kvClear,
    executeQuery,
    makeVatStore,
    deleteVatStore,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
    close: () => db.close(),
  };
}
