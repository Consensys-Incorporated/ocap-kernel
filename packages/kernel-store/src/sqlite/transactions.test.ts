import { describe, it, expect, vi } from 'vitest';

import { makeTransactionMethods } from './transactions.ts';

/**
 * A database that answers `inTransaction` the way SQLite does: only the
 * injected begin/commit/abort move it, and a test can end the transaction
 * behind the driver's back the way SQLite does after `SQLITE_FULL`.
 *
 * @returns The fake database and the methods built over it.
 */
const makeFakeDriver = () => {
  let inTransaction = false;
  const db = {
    get inTransaction() {
      return inTransaction;
    },
    _spStack: [] as string[],
    exec: vi.fn(),
  };
  const endTransactionBehindOurBack = () => {
    inTransaction = false;
  };
  const begin = vi.fn(() => {
    inTransaction = true;
  });
  const commit = vi.fn(endTransactionBehindOurBack);
  const abort = vi.fn(endTransactionBehindOurBack);

  return {
    db,
    begin,
    commit,
    abort,
    endTransactionBehindOurBack,
    ...makeTransactionMethods({ db, begin, commit, abort }),
  };
};

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
  ])('rejects the savepoint name %j', (name) => {
    const { db, createSavepoint } = makeFakeDriver();

    expect(() => createSavepoint(name)).toThrow('Invalid identifier');
    expect(db.exec).not.toHaveBeenCalled();
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
    const { db, abort, createSavepoint, rollbackSavepoint } = makeFakeDriver();
    createSavepoint('t0');
    db.exec.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });

    expect(() => rollbackSavepoint('t0')).toThrow('disk I/O error');

    expect(abort).toHaveBeenCalledOnce();
    expect(db._spStack).toStrictEqual([]);
  });

  it('reports the rollback failure even if the abort fails too', () => {
    const { db, abort, createSavepoint, rollbackSavepoint } = makeFakeDriver();
    createSavepoint('t0');
    db.exec.mockImplementationOnce(() => {
      throw new Error('disk I/O error');
    });
    abort.mockImplementationOnce(() => {
      throw new Error('cannot rollback');
    });

    expect(() => rollbackSavepoint('t0')).toThrow('disk I/O error');

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
});
