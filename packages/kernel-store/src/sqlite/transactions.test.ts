import type { Logger } from '@metamask/logger';
import { describe, it, expect, vi } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { makeTransactionMethods } from './transactions.ts';

const { BEGIN_TRANSACTION, COMMIT_TRANSACTION, ABORT_TRANSACTION } =
  SQL_QUERIES;

/**
 * A database that answers `inTransaction` the way SQLite does: a statement that
 * throws changes nothing, one that succeeds opens or closes the transaction,
 * and `endTransactionBehindOurBack` is SQLite ending one itself after
 * `SQLITE_FULL`. A mock that cannot model recovery can only ever model a wedged
 * connection, which is the state under test.
 *
 * @returns The fake database, the methods built over it, and the levers a test
 * needs: `issued` in order, and `failOnce` to make the next run of one
 * statement throw.
 */
const makeFakeDriver = () => {
  let inTransaction = false;
  const issued: string[] = [];
  const failOnce = new Set<string>();

  let abortLeavesItOpen = false;

  const run = (sql: string): void => {
    issued.push(sql);
    if (failOnce.delete(sql)) {
      throw new Error(`SQLITE_IOERR: ${sql}`);
    }
    if (sql === BEGIN_TRANSACTION) {
      inTransaction = true;
    } else if (sql === COMMIT_TRANSACTION) {
      inTransaction = false;
    } else if (sql === ABORT_TRANSACTION) {
      inTransaction = abortLeavesItOpen;
    }
  };

  const db = {
    get inTransaction() {
      return inTransaction;
    },
    _spStack: [] as string[],
    exec: vi.fn(run),
  };
  const begin = vi.fn(() => run(BEGIN_TRANSACTION));
  const commit = vi.fn(() => run(COMMIT_TRANSACTION));
  const abort = vi.fn(() => run(ABORT_TRANSACTION));
  const logger = { error: vi.fn() } as unknown as Logger;

  return {
    db,
    issued,
    failOnce,
    begin,
    commit,
    abort,
    logger,
    endTransactionBehindOurBack: () => {
      inTransaction = false;
    },
    keepTransactionOpenPastTheAbort: () => {
      abortLeavesItOpen = true;
    },
    ...makeTransactionMethods({ db, begin, commit, abort, logger }),
  };
};

type FakeDriver = ReturnType<typeof makeFakeDriver>;

describe('makeTransactionMethods', () => {
  it('opens a transaction for the outermost savepoint', () => {
    const { db, begin, createSavepoint } = makeFakeDriver();

    createSavepoint('t0');

    expect(begin).toHaveBeenCalledOnce();
    expect(db.exec).toHaveBeenCalledWith('SAVEPOINT t0');
    expect(db._spStack).toStrictEqual(['t0']);
  });

  it('nests a savepoint in the transaction the outer one opened', () => {
    const { db, begin, commit, createSavepoint, releaseSavepoint } =
      makeFakeDriver();

    createSavepoint('t0');
    createSavepoint('t1');
    expect(begin).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual(['t0', 't1']);

    releaseSavepoint('t1');
    expect(commit).not.toHaveBeenCalled();
    releaseSavepoint('t0');
    expect(commit).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
  });

  it.each([
    'invalid-name',
    '123numeric',
    'spaces not allowed',
    "point'; DROP TABLE kv--",
  ])('rejects the savepoint name %j without opening a transaction', (name) => {
    const { db, issued, createSavepoint } = makeFakeDriver();

    expect(() => createSavepoint(name)).toThrow('Invalid identifier');
    // A transaction opened for a name that is then refused has no savepoint to
    // reach it through, so nothing would ever end it.
    expect(issued).toStrictEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it.each(['rollbackSavepoint', 'releaseSavepoint'] as const)(
    '%s refuses a savepoint that is not on the stack',
    (method) => {
      const methods = makeFakeDriver();
      methods.createSavepoint('t0');

      expect(() => methods[method]('t1')).toThrow('No such savepoint: t1');
    },
  );

  it('rolls back to a savepoint and drops the ones above it', () => {
    const { db, abort, createSavepoint, rollbackSavepoint } = makeFakeDriver();
    createSavepoint('t0');
    createSavepoint('t1');
    createSavepoint('t2');

    rollbackSavepoint('t1');

    expect(db.exec).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT t1');
    expect(db._spStack).toStrictEqual(['t0']);
    expect(abort).not.toHaveBeenCalled();
  });

  it('aborts the transaction when the last savepoint rolls back', () => {
    const { db, abort, createSavepoint, rollbackSavepoint } = makeFakeDriver();
    createSavepoint('t0');

    rollbackSavepoint('t0');

    expect(abort).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
  });

  it('releases a savepoint and drops the ones above it', () => {
    const { db, commit, createSavepoint, releaseSavepoint } = makeFakeDriver();
    createSavepoint('t0');
    createSavepoint('t1');
    createSavepoint('t2');

    releaseSavepoint('t1');

    expect(db.exec).toHaveBeenCalledWith('RELEASE SAVEPOINT t1');
    expect(db._spStack).toStrictEqual(['t0']);
    expect(commit).not.toHaveBeenCalled();
  });

  it('commits the transaction when the last savepoint is released', () => {
    const { db, commit, createSavepoint, releaseSavepoint } = makeFakeDriver();
    createSavepoint('t0');

    releaseSavepoint('t0');

    expect(db.exec).toHaveBeenCalledWith('RELEASE SAVEPOINT t0');
    expect(commit).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
  });

  it('discards the transaction when the rollback itself fails', () => {
    const { db, abort, failOnce, createSavepoint, rollbackSavepoint } =
      makeFakeDriver();
    createSavepoint('t0');
    failOnce.add('ROLLBACK TO SAVEPOINT t0');

    expect(() => rollbackSavepoint('t0')).toThrow('SQLITE_IOERR');

    expect(abort).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
    expect(db.inTransaction).toBe(false);
  });

  it('reports the rollback failure even if the abort fails too', () => {
    const { db, failOnce, createSavepoint, rollbackSavepoint } =
      makeFakeDriver();
    createSavepoint('t0');
    failOnce.add('ROLLBACK TO SAVEPOINT t0');
    failOnce.add(ABORT_TRANSACTION);

    expect(() => rollbackSavepoint('t0')).toThrow(
      'SQLITE_IOERR: ROLLBACK TO SAVEPOINT t0',
    );

    expect(db._spStack).toStrictEqual([]);
  });

  it('drops savepoints SQLite discarded with the transaction', () => {
    const {
      db,
      begin,
      commit,
      endTransactionBehindOurBack,
      createSavepoint,
      releaseSavepoint,
    } = makeFakeDriver();
    createSavepoint('t0');
    endTransactionBehindOurBack();

    createSavepoint('t1');
    releaseSavepoint('t1');

    expect(begin).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
  });

  it('leaves an open transaction to whoever began it', () => {
    const { begin, beginIfNeeded } = makeFakeDriver();
    beginIfNeeded();

    expect(beginIfNeeded()).toBe(false);
    expect(begin).toHaveBeenCalledOnce();
  });

  it('leaves the commit to the savepoint that owns the transaction', () => {
    const { commit, createSavepoint, commitIfNeeded } = makeFakeDriver();
    createSavepoint('t0');

    commitIfNeeded();

    expect(commit).not.toHaveBeenCalled();
  });

  it.each([
    { method: 'commitIfNeeded', mock: 'commit' },
    { method: 'rollbackIfNeeded', mock: 'abort' },
  ] as const)(
    '$method does nothing outside a transaction',
    ({ method, mock }) => {
      const methods = makeFakeDriver();

      methods[method]();

      expect(methods[mock]).not.toHaveBeenCalled();
    },
  );

  describe('a transaction an abort could not end', () => {
    /**
     * Wedge the connection the way a full disk does: the crank's rollback
     * fails, and so does the abort meant to discard the transaction instead.
     *
     * @returns The driver, mid-crank, with the transaction abandoned.
     */
    const abandon = () => {
      const driver = makeFakeDriver();
      driver.createSavepoint('t0');
      driver.createSavepoint('t1');
      driver.failOnce.add('ROLLBACK TO SAVEPOINT t1');
      driver.failOnce.add(ABORT_TRANSACTION);

      expect(() => driver.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');
      // The savepoint stack now says "nothing to commit or abort" while SQLite
      // still holds t0, t1 and the transaction.
      expect(driver.db._spStack).toStrictEqual([]);
      expect(driver.db.inTransaction).toBe(true);
      driver.issued.length = 0;
      return driver;
    };

    it('discards it before the next savepoint can join it', () => {
      const { issued, createSavepoint, releaseSavepoint } = abandon();

      createSavepoint('teardown');
      releaseSavepoint('teardown');

      expect(issued).toStrictEqual([
        ABORT_TRANSACTION,
        BEGIN_TRANSACTION,
        'SAVEPOINT teardown',
        'RELEASE SAVEPOINT teardown',
        COMMIT_TRANSACTION,
      ]);
    });

    it.each([
      { what: 'a savepoint', write: 'createSavepoint', name: 'teardown' },
      { what: 'a rollback', write: 'rollbackSavepoint', name: 't0' },
      { what: 'a release', write: 'releaseSavepoint', name: 't0' },
    ] as const)(
      'refuses $what while the abort keeps failing',
      ({ write, name }) => {
        const driver = abandon();
        driver.failOnce.add(ABORT_TRANSACTION);

        expect(() => driver[write](name)).toThrow(
          expect.objectContaining({
            message: expect.stringContaining('refusing further writes'),
            cause: expect.objectContaining({
              message: `SQLITE_IOERR: ${ABORT_TRANSACTION}`,
            }),
          }),
        );
        expect(driver.issued).toStrictEqual([ABORT_TRANSACTION]);
      },
    );

    // SQLite ending the transaction is the only way out of an abort that keeps
    // failing. Refusing writes past that point would refuse them forever.
    it('writes again once SQLite has ended it', () => {
      const { issued, endTransactionBehindOurBack, assertNotAbandoned } =
        abandon();
      endTransactionBehindOurBack();

      expect(() => assertNotAbandoned()).not.toThrow();
      expect(issued).toStrictEqual([]);
    });

    // An abort that returns without ending the transaction leaves one that is
    // still not ours to commit, and reports nothing for the catch to notice.
    it('stays abandoned when the abort returns but the transaction does not end', () => {
      const {
        db,
        failOnce,
        keepTransactionOpenPastTheAbort,
        createSavepoint,
        rollbackSavepoint,
      } = makeFakeDriver();
      keepTransactionOpenPastTheAbort();
      createSavepoint('t0');
      createSavepoint('t1');
      failOnce.add('ROLLBACK TO SAVEPOINT t1');
      expect(() => rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

      expect(db.inTransaction).toBe(true);
      expect(() => createSavepoint('teardown')).toThrow(
        'refusing further writes',
      );
    });

    it('reports the abort that failed while discarding it', () => {
      const { logger } = abandon();

      expect(logger.error).toHaveBeenCalledWith(
        'failed to discard transaction after rollback',
        expect.objectContaining({
          message: `SQLITE_IOERR: ${ABORT_TRANSACTION}`,
        }),
      );
    });
  });

  it.each([
    {
      after: 'rollback',
      arrange: (driver: FakeDriver) => {
        driver.createSavepoint('t0');
        driver.failOnce.add('ROLLBACK TO SAVEPOINT t0');
        return () => driver.rollbackSavepoint('t0');
      },
    },
    {
      after: 'release',
      arrange: (driver: FakeDriver) => {
        driver.createSavepoint('t0');
        driver.createSavepoint('t1');
        driver.failOnce.add('RELEASE SAVEPOINT t1');
        return () => driver.releaseSavepoint('t1');
      },
    },
    {
      after: 'commit',
      arrange: (driver: FakeDriver) => {
        driver.createSavepoint('t0');
        driver.failOnce.add(COMMIT_TRANSACTION);
        return () => driver.releaseSavepoint('t0');
      },
    },
    {
      after: 'savepoint creation',
      arrange: (driver: FakeDriver) => {
        driver.failOnce.add('SAVEPOINT t0');
        return () => driver.createSavepoint('t0');
      },
    },
  ])('names the $after it was discarding after', ({ after, arrange }) => {
    const driver = makeFakeDriver();
    const act = arrange(driver);
    driver.failOnce.add(ABORT_TRANSACTION);

    expect(act).toThrow('SQLITE_IOERR');

    expect(driver.logger.error).toHaveBeenCalledWith(
      `failed to discard transaction after ${after}`,
      expect.any(Error),
    );
  });

  it('discards the transaction when the release fails', () => {
    const { db, issued, failOnce, createSavepoint, releaseSavepoint } =
      makeFakeDriver();
    createSavepoint('t0');
    createSavepoint('t1');
    issued.length = 0;
    failOnce.add('RELEASE SAVEPOINT t1');

    expect(() => releaseSavepoint('t1')).toThrow('SQLITE_IOERR');

    // `t0` is still on SQLite's stack, so leaving it here would hand the crank
    // a rollback target inside a transaction nothing owns.
    expect(issued).toStrictEqual(['RELEASE SAVEPOINT t1', ABORT_TRANSACTION]);
    expect(db.inTransaction).toBe(false);
    expect(db._spStack).toStrictEqual([]);
  });

  it('discards the transaction when the commit fails', () => {
    const { db, issued, failOnce, createSavepoint, releaseSavepoint } =
      makeFakeDriver();
    createSavepoint('t0');
    issued.length = 0;
    // endCrank: the RELEASE succeeds, the COMMIT it triggers does not. The
    // savepoint stack is already spliced empty, so nothing else would end it.
    failOnce.add(COMMIT_TRANSACTION);

    expect(() => releaseSavepoint('t0')).toThrow('SQLITE_IOERR');

    expect(issued).toStrictEqual([
      'RELEASE SAVEPOINT t0',
      COMMIT_TRANSACTION,
      ABORT_TRANSACTION,
    ]);
    expect(db.inTransaction).toBe(false);
  });

  it('discards the transaction it began when the savepoint then fails', () => {
    const { db, issued, failOnce, createSavepoint } = makeFakeDriver();
    failOnce.add('SAVEPOINT t0');

    expect(() => createSavepoint('t0')).toThrow('SQLITE_IOERR');

    expect(issued).toStrictEqual([
      BEGIN_TRANSACTION,
      'SAVEPOINT t0',
      ABORT_TRANSACTION,
    ]);
    expect(db.inTransaction).toBe(false);
    expect(db._spStack).toStrictEqual([]);
  });

  it('leaves a transaction it found open for its owner to discard', () => {
    const { db, issued, failOnce, createSavepoint } = makeFakeDriver();
    createSavepoint('t0');
    issued.length = 0;
    failOnce.add('SAVEPOINT t1');

    expect(() => createSavepoint('t1')).toThrow('SQLITE_IOERR');

    // Discarding here would abort the crank behind its back; it still has `t0`
    // to reach its own rollback through.
    expect(issued).toStrictEqual(['SAVEPOINT t1']);
    expect(db.inTransaction).toBe(true);
    expect(db._spStack).toStrictEqual(['t0']);
  });
});
