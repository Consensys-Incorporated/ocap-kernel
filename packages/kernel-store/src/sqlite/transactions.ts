import type { Logger } from '@metamask/logger';

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
  assertWritable: () => void;
  guardWrite: <Args extends unknown[], Result>(
    write: (...args: Args) => Result,
  ) => (...args: Args) => Result;
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
 * @param options.logger - A logger, for an abort that fails.
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
  // Set when an abort meant to discard a transaction fails. The writes of the
  // crank we gave up on are still in it, and a savepoint taken inside it would
  // be released into it.
  let txAbandoned = false;
  // Why, for whoever catches the refusal: the logger is the embedder's to pass
  // and may not be there.
  let abortFailure: unknown;
  // The error a write threw as SQLite rolled back the transaction, kept as the
  // cause of what is thrown until the savepoint is rolled back or released,
  // since whoever caught it may swallow it.
  let lossCause: unknown;

  /**
   * Refuse to touch a transaction an earlier abort could not end. A savepoint
   * created inside one is released into it, committing the crank that abort was
   * discarding, and a COMMIT makes those writes durable outright. Retried once
   * first, since the failure may have been transient.
   *
   * @throws If the transaction is still there afterwards. Returning normally
   * would tell the caller its write landed.
   */
  function assertNotAbandoned(): void {
    if (!txAbandoned) {
      return;
    }
    discardTransaction('abandonment');
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
   * Refuse a write into a transaction an abort could not end, where it would be
   * lost with that transaction, or into one SQLite has rolled back, where it
   * would commit alone while the work around it is gone. Rolling back or
   * releasing the savepoint ends the refusal.
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
   * Wrap a write so that it asks {@link assertWritable} first.
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
        }
        throw error;
      }
    };
  }

  /**
   * Tell a savepoint's owner that SQLite has already ended its transaction,
   * taking every savepoint in it.
   *
   * @param name - The savepoint.
   * @throws If the transaction has ended, after clearing the stack as any failed
   * rollback or release does.
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
   * Discard the transaction after a failure that leaves it unowned, keeping the
   * error that got us here rather than the abort's.
   *
   * @param after - What failed, completing "failed to discard transaction
   * after ...".
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
      // A failed COMMIT can leave the transaction open, and `releaseSavepoint`
      // reaches here outside any try of its own — the same hazard the savepoint
      // paths below discard the transaction to avoid, by a third door.
      discardTransaction('commit');
      throw error;
    }
  }

  /**
   * Abort a transaction if one is active.
   */
  function rollbackIfNeeded(): void {
    if (!db.inTransaction) {
      txAbandoned = false;
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
    // Normally false now. If SQLite still reports a transaction, it is still
    // not ours to commit.
    txAbandoned = db.inTransaction;
  }

  /**
   * Find a savepoint on the stack, or throw.
   *
   * @param name - The name of the savepoint.
   * @returns Its index on the stack.
   */
  function requireSavepoint(name: string): number {
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
    // Ahead of the BEGIN, so a name this refuses leaves no transaction behind.
    assertSafeIdentifier(name);
    // We must be in a transaction when creating the savepoint or releasing it
    // later will cause an autocommit.
    // See https://github.com/Agoric/agoric-sdk/issues/8423
    const startedTransaction = beginIfNeeded();
    try {
      db.exec(SQL_QUERIES.CREATE_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // Nothing was pushed, so no savepoint path would reach this transaction
      // and `txAbandoned` is unset: left open, it would take every later write
      // and be committed by some unrelated release. One we merely found open is
      // the caller's to discard, not ours.
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
    assertNotAbandoned();
    const idx = requireSavepoint(name);
    assertSavepointLive(name);
    try {
      db.exec(SQL_QUERIES.ROLLBACK_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // Left as it was, the savepoint stays on the stack and the transaction open
      // with nothing to ever commit or abort it, so every later write on this
      // connection joins it, reports success, and vanishes on close. Discarding
      // the whole transaction is safe: it begins with the outermost savepoint, so
      // it holds only what this rollback was abandoning anyway.
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
    assertNotAbandoned();
    const idx = requireSavepoint(name);
    assertSavepointLive(name);
    try {
      db.exec(SQL_QUERIES.RELEASE_SAVEPOINT.replace('%NAME%', name));
    } catch (error) {
      // The hazard `rollbackSavepoint` guards against, by the other door, and
      // there is no committing this transaction now.
      discardTransaction('release');
      throw error;
    }
    db._spStack.splice(idx);
    if (db._spStack.length === 0) {
      commitIfNeeded();
    }
  }

  return {
    assertWritable,
    guardWrite,
    beginIfNeeded,
    commitIfNeeded,
    rollbackIfNeeded,
    createSavepoint,
    rollbackSavepoint,
    releaseSavepoint,
  };
}
