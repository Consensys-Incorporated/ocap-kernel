import type { Logger } from '@metamask/logger';

import { SQL_QUERIES, assertSafeIdentifier } from './common.ts';

/**
 * What the transaction methods need of a driver's database handle.
 *
 * `_spStack` is not a faithful mirror of SQLite's savepoint stack:
 * `ROLLBACK TO x` keeps `x` in SQLite but drops it here. That is safe while no
 * savepoint is opened under a name already on the stack, ignoring case: SQLite
 * resolves a name to its newest savepoint, which could then be a leftover the
 * stack no longer shows.
 */
export type TransactionalDatabase = {
  readonly inTransaction: boolean;
  _spStack: string[];
  exec: (sql: string) => unknown;
};

export type TransactionMethods = {
  guardWrite: <Args extends unknown[], Result>(
    write: (...args: Args) => Result,
  ) => (...args: Args) => Result;
  beginIfNeeded: () => boolean;
  commitIfNeeded: () => void;
  createSavepoint: (name: string) => void;
  rollbackSavepoint: (name: string) => void;
  releaseSavepoint: (name: string) => void;
};

/**
 * Make a SQLite driver's transaction and savepoint methods.
 *
 * @param options - Options bag.
 * @param options.db - The open database.
 * @param options.begin - Runs the driver's prepared `BEGIN TRANSACTION`.
 * @param options.commit - Runs the driver's prepared `COMMIT TRANSACTION`.
 * @param options.abort - Runs the driver's prepared `ROLLBACK TRANSACTION`.
 * @param options.logger - The logger for a discard whose abort fails.
 * @returns The transaction and savepoint methods.
 */
export function makeTransactionMethods({
  db,
  begin,
  commit,
  abort,
  logger,
}: {
  db: TransactionalDatabase;
  begin: () => void;
  commit: () => void;
  abort: () => void;
  logger?: Logger | undefined;
}): TransactionMethods {
  let txAbandoned = false;
  let abortFailure: unknown;
  // The write error SQLite rolled back on, which its catcher may have swallowed.
  let lossCause: unknown;

  /**
   * Refuse every write once an abort has failed. While the transaction is open,
   * a write would join the work that abort was discarding. Once it ends, the
   * caller may still hold values it read from inside it, so only reopening the
   * database lifts the refusal.
   */
  function assertNotAbandoned(): void {
    if (txAbandoned) {
      throw new Error(
        'transaction cannot be ended; refusing further writes on this connection',
        { cause: abortFailure },
      );
    }
  }

  /**
   * Whether SQLite has rolled back, on its own, the transaction a savepoint on
   * the stack was taken in.
   *
   * @returns True if so.
   */
  function isTransactionLost(): boolean {
    return db._spStack.length > 0 && !db.inTransaction;
  }

  /**
   * Refuse a write into a transaction an abort could not end, or into one
   * SQLite has rolled back, where it would commit alone while the work around it
   * is gone. The first lasts until the database is reopened; rolling back or
   * releasing a savepoint ends the second.
   *
   * @throws If either holds.
   */
  function assertWritable(): void {
    assertNotAbandoned();
    if (isTransactionLost()) {
      throw new Error(
        `SQLite ended the transaction holding savepoint ${db._spStack[0]}; refusing writes until it is rolled back or released`,
        { cause: lossCause },
      );
    }
  }

  /**
   * Wrap a write so that it asks {@link assertWritable} first, and discards a
   * transaction it began and could not end.
   *
   * @param write - The write.
   * @returns The guarded write.
   */
  function guardWrite<Args extends unknown[], Result>(
    write: (...args: Args) => Result,
  ): (...args: Args) => Result {
    return (...args) => {
      assertWritable();
      try {
        return write(...args);
      } catch (error) {
        if (isTransactionLost()) {
          lossCause = error;
        } else if (
          !txAbandoned &&
          db.inTransaction &&
          db._spStack.length === 0
        ) {
          // An abandoned one has just failed its abort.
          discardTransaction('write');
        }
        throw error;
      }
    };
  }

  /**
   * Tell a savepoint's owner that SQLite has already ended its transaction.
   *
   * @param name - The savepoint.
   * @throws If it has, after clearing the stack of the savepoints SQLite took
   * with it.
   */
  function assertSavepointLive(name: string): void {
    if (db.inTransaction) {
      return;
    }
    db._spStack.length = 0;
    const cause = lossCause;
    lossCause = undefined;
    throw new Error(
      `SQLite already ended the transaction holding savepoint ${name}`,
      { cause },
    );
  }

  /**
   * Discard the transaction after a failure that leaves it unowned.
   *
   * @param after - What failed.
   */
  function discardTransaction(after: string): void {
    db._spStack.length = 0;
    try {
      rollbackIfNeeded();
    } catch (error) {
      logger?.error(`failed to discard transaction after ${after}`, error);
    }
  }

  /**
   * Begin a transaction if not already in one.
   *
   * @returns True if a new transaction was started, false if already in one.
   */
  function beginIfNeeded(): boolean {
    assertWritable();
    if (db.inTransaction) {
      return false;
    }
    begin();
    return true;
  }

  /**
   * Commit a transaction if one is active and no savepoints remain.
   */
  function commitIfNeeded(): void {
    assertNotAbandoned();
    if (!db.inTransaction || db._spStack.length > 0) {
      return;
    }
    try {
      commit();
    } catch (error) {
      // A failed COMMIT can leave the transaction open, with no savepoint left
      // to reach it.
      discardTransaction('commit');
      throw error;
    }
  }

  /**
   * Abort a transaction if one is active.
   */
  function rollbackIfNeeded(): void {
    if (!db.inTransaction) {
      return;
    }
    try {
      abort();
    } catch (error) {
      txAbandoned = true;
      abortFailure = error;
      throw error;
    }
    db._spStack.length = 0;
    // If SQLite still reports a transaction, it is still not ours to commit.
    txAbandoned = db.inTransaction;
  }

  /**
   * Find a savepoint on the stack whose transaction is still there to roll back
   * or release, or throw.
   *
   * @param name - The name of the savepoint.
   * @returns Its index on the stack.
   */
  function requireSavepoint(name: string): number {
    assertNotAbandoned();
    assertSafeIdentifier(name);
    const idx = db._spStack.lastIndexOf(name);
    if (idx < 0) {
      throw new Error(`No such savepoint: ${name}`);
    }
    assertSavepointLive(name);
    return idx;
  }

  /**
   * Create a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function createSavepoint(name: string): void {
    // Ahead of the BEGIN, so a name this refuses leaves no transaction behind.
    assertSafeIdentifier(name);
    // We must be in a transaction when creating the savepoint or releasing it
    // later will cause an autocommit.
    // See https://github.com/Agoric/agoric-sdk/issues/8423
    const startedTransaction = beginIfNeeded();
    try {
      db.exec(SQL_QUERIES.CREATE_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // One we merely found open is the caller's to discard, not ours.
      if (startedTransaction) {
        discardTransaction('savepoint creation');
      }
      throw error;
    }
    db._spStack.push(name);
  }

  /**
   * Rollback to a savepoint in the database.
   *
   * @param name - The name of the savepoint.
   */
  function rollbackSavepoint(name: string): void {
    const idx = requireSavepoint(name);
    try {
      db.exec(SQL_QUERIES.ROLLBACK_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // Left as it was, the savepoint stays on the stack and the transaction open
      // with nothing to ever commit or abort it, so every later write on this
      // connection joins it, reports success, and vanishes on close. Discarding
      // the transaction loses the work of the savepoints below this one too.
      discardTransaction('rollback');
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
    const idx = requireSavepoint(name);
    try {
      db.exec(SQL_QUERIES.RELEASE_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // A nested one's transaction still has owners below it to end it.
      if (idx === 0) {
        discardTransaction('release');
      }
      throw error;
    }
    db._spStack.splice(idx);
    if (db._spStack.length === 0) {
      commitIfNeeded();
    }
  }

  return {
    guardWrite,
    beginIfNeeded,
    commitIfNeeded,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
  };
}
