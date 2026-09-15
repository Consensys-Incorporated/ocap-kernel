import { SQL_QUERIES, assertSafeIdentifier } from './common.ts';

/**
 * What the transaction methods need of a driver's database handle. `_spStack`
 * is not a faithful mirror of SQLite's savepoint stack: `ROLLBACK TO tN` leaves
 * `tN` alive in SQLite, and `splice` drops it here. Harmless so far, because
 * the eventual `RELEASE t0` sweeps the orphans.
 */
export type TransactionalDatabase = {
  readonly inTransaction: boolean;
  _spStack: string[];
  exec: (sql: string) => unknown;
};

export type TransactionMethods = {
  beginIfNeeded: () => boolean;
  commitIfNeeded: () => void;
  rollbackIfNeeded: () => void;
  createSavepoint: (name: string) => void;
  rollbackSavepoint: (name: string) => void;
  releaseSavepoint: (name: string) => void;
};

/**
 * Make the transaction and savepoint methods a SQLite driver exposes.
 *
 * @param options - Options bag.
 * @param options.db - The open database.
 * @param options.begin - Runs the driver's prepared `BEGIN TRANSACTION`.
 * @param options.commit - Runs the driver's prepared `COMMIT TRANSACTION`.
 * @param options.abort - Runs the driver's prepared `ROLLBACK TRANSACTION`.
 * @returns The transaction and savepoint methods.
 */
export function makeTransactionMethods({
  db,
  begin,
  commit,
  abort,
}: {
  db: TransactionalDatabase;
  begin: () => void;
  commit: () => void;
  abort: () => void;
}): TransactionMethods {
  /**
   * Begin a transaction if not already in one.
   *
   * @returns True if a new transaction was started, false if already in one.
   */
  function beginIfNeeded(): boolean {
    if (db.inTransaction) {
      return false;
    }
    begin();
    // A savepoint named on the stack belonged to the transaction SQLite ended,
    // and is gone with it. Left there, it makes `commitIfNeeded` defer to an
    // owner that no longer exists, and nothing ever commits this one.
    db._spStack.length = 0;
    return true;
  }

  /**
   * Commit a transaction if one is active and no savepoints remain.
   */
  function commitIfNeeded(): void {
    if (db.inTransaction && db._spStack.length === 0) {
      commit();
    }
  }

  /**
   * Abort a transaction if one is active.
   */
  function rollbackIfNeeded(): void {
    if (db.inTransaction) {
      abort();
      db._spStack.length = 0;
    }
  }

  /**
   * Find a savepoint on the stack.
   *
   * @param name - The name of the savepoint.
   * @returns Its index on the stack.
   */
  function findSavepoint(name: string): number {
    assertSafeIdentifier(name);
    const idx = db._spStack.lastIndexOf(name);
    if (idx < 0) {
      throw new Error(`No such savepoint: ${name}`);
    }
    return idx;
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
    db.exec(SQL_QUERIES.CREATE_SAVEPOINT.replace('%NAME%', name));
    db._spStack.push(name);
  }

  /**
   * Rollback to a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function rollbackSavepoint(name: string): void {
    const idx = findSavepoint(name);
    try {
      db.exec(SQL_QUERIES.ROLLBACK_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // Left as it was, the savepoint stays on the stack and the transaction open
      // with nothing to ever commit or abort it, so every later write on this
      // connection joins it, reports success, and vanishes on close. Discarding
      // the whole transaction is safe: it begins with the outermost savepoint, so
      // it holds only what this rollback was abandoning anyway.
      db._spStack.length = 0;
      try {
        rollbackIfNeeded();
      } catch {
        // The rollback failure below is the one worth reporting.
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
    const idx = findSavepoint(name);
    db.exec(SQL_QUERIES.RELEASE_SAVEPOINT.replace('%NAME%', name));
    db._spStack.splice(idx);
    if (db._spStack.length === 0) {
      commitIfNeeded();
    }
  }

  return {
    beginIfNeeded,
    commitIfNeeded,
    rollbackIfNeeded,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
  };
}
