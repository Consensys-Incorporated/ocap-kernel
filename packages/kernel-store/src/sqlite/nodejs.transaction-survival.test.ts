import type { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { makeSQLKernelDatabase } from './nodejs.ts';
import type { KernelDatabase } from '../types.ts';

/**
 * Two invariants the crank layer relies on:
 *
 * - a failed `ROLLBACK TO` discards the whole transaction;
 * - `commitIfNeeded` leaves no transaction behind.
 *
 * Both hold only while the abort doing the discarding succeeds. When it does
 * not, the driver logs it and refuses every later write rather than let one
 * join a transaction nothing will commit; `_spStack` is emptied either way, so
 * it no longer matches the database.
 */

/** Every statement and exec call, in order. */
let issued: string[] = [];
/** SQL that throws when next run. */
let failOnce: Set<string> = new Set();

/** What SQLite would report through `db.inTransaction`. */
let inTransaction = false;

/**
 * Run one statement against the mock, tracking the transaction the way SQLite
 * does: a statement that throws changes nothing, and one that succeeds opens or
 * closes the transaction. Without the latter the mock can only ever model a
 * connection that is wedged, which is the state under test here and so exactly
 * the state that must not be assumed.
 *
 * @param text - The SQL being run.
 */
function runSql(text: string): void {
  issued.push(text);
  if (failOnce.delete(text)) {
    throw new Error(`SQLITE_IOERR: ${text}`);
  }
  if (text === 'BEGIN TRANSACTION') {
    inTransaction = true;
  } else if (text === 'COMMIT TRANSACTION' || text === 'ROLLBACK TRANSACTION') {
    inTransaction = false;
  }
}

const makeStatement = (text: string): Record<string, unknown> => ({
  run: () => {
    runSql(text);
    return undefined;
  },
  get: () => undefined,
  all: () => [],
  pluck: () => undefined,
  iterate: () => [],
});

const mockDb = {
  prepare: vi.fn((text: string) => makeStatement(text)),
  transaction: vi.fn((fn: () => void) => fn),
  exec: vi.fn(runSql),
  get inTransaction(): boolean {
    return inTransaction;
  },
  set inTransaction(value: boolean) {
    inTransaction = value;
  },
  _spStack: [] as string[],
  close: vi.fn(),
};

vi.mock('better-sqlite3', () => ({
  default: vi.fn(function () {
    return mockDb;
  }),
}));
vi.mock('node:fs/promises', () => ({ mkdir: vi.fn() }));
vi.mock('node:os', () => ({ tmpdir: vi.fn(() => '/mock-tmpdir') }));

describe('the nodejs driver after a failure it tolerates', () => {
  beforeEach(() => {
    issued = [];
    failOnce = new Set();
    mockDb.inTransaction = false;
    mockDb._spStack = [];
  });

  it('discards the transaction when the rollback fails and the abort fails too', async () => {
    const kdb = await makeSQLKernelDatabase({});
    // A crank in progress: SAVEPOINT t0, SAVEPOINT t1.
    mockDb.inTransaction = true;
    mockDb._spStack = ['t0', 't1'];
    issued = [];

    // The disk fills. `ROLLBACK TO SAVEPOINT t1` fails, and so does the
    // `ROLLBACK TRANSACTION` meant to discard the transaction instead. The
    // driver logs that second failure and rethrows the first, so SQLite is
    // still in a transaction with t0 and t1 on its stack.
    failOnce.add('ROLLBACK TO SAVEPOINT t1');
    failOnce.add('ROLLBACK TRANSACTION');
    expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');
    expect(mockDb._spStack).toStrictEqual([]);
    expect(mockDb.inTransaction).toBe(true);

    // `_spStack` now says "no savepoints, nothing to commit or abort" while
    // SQLite says otherwise. Teardown still runs after the run loop dies --
    // `reset`, a peer incarnation change, a remote message -- and takes a
    // savepoint.
    issued = [];
    kdb.createSavepoint('teardown');
    kdb.releaseSavepoint('teardown');

    // The abandoned transaction is retried and discarded before the new
    // savepoint can join it, so what the COMMIT makes durable is `teardown`'s
    // own transaction and not the crank that was thrown away.
    expect(issued).toStrictEqual([
      'ROLLBACK TRANSACTION',
      'BEGIN TRANSACTION',
      'SAVEPOINT teardown',
      'RELEASE SAVEPOINT teardown',
      'COMMIT TRANSACTION',
    ]);
  });

  it('discards a transaction it began when the savepoint then fails', async () => {
    const kdb = await makeSQLKernelDatabase({});
    issued = [];

    // Out of any transaction, so this call issues the BEGIN itself, and then
    // the SAVEPOINT fails. Nothing would be on the savepoint stack to reach
    // that transaction through and `txAbandoned` would be unset, so the orphan
    // would take every later write and be committed by an unrelated release.
    failOnce.add('SAVEPOINT t0');
    expect(() => kdb.createSavepoint('t0')).toThrow('SQLITE_IOERR');

    expect(issued).toStrictEqual([
      'BEGIN TRANSACTION',
      'SAVEPOINT t0',
      'ROLLBACK TRANSACTION',
    ]);
    expect(mockDb.inTransaction).toBe(false);
    expect(mockDb._spStack).toStrictEqual([]);
  });

  it('leaves a transaction it found open for its owner to discard', async () => {
    const kdb = await makeSQLKernelDatabase({});
    // A crank in progress: the transaction and `t0` are the run loop's.
    mockDb.inTransaction = true;
    mockDb._spStack = ['t0'];
    issued = [];

    failOnce.add('SAVEPOINT t1');
    expect(() => kdb.createSavepoint('t1')).toThrow('SQLITE_IOERR');

    // Discarding here would abort the crank behind its back; it still has `t0`
    // to reach its own rollback through.
    expect(issued).toStrictEqual(['SAVEPOINT t1']);
    expect(mockDb.inTransaction).toBe(true);
    expect(mockDb._spStack).toStrictEqual(['t0']);
  });

  // Teardown after the run loop dies reaches the store by many doors, most of
  // which never touch `beginIfNeeded`.
  it.each([
    {
      what: 'a savepoint',
      write: (kdb: KernelDatabase) => kdb.createSavepoint('teardown'),
      sql: 'SAVEPOINT teardown',
    },
    {
      what: 'a savepoint rollback',
      write: (kdb: KernelDatabase) => kdb.rollbackSavepoint('t0'),
      sql: 'ROLLBACK TO SAVEPOINT t0',
    },
    {
      what: 'a savepoint release',
      write: (kdb: KernelDatabase) => kdb.releaseSavepoint('t0'),
      sql: 'RELEASE SAVEPOINT t0',
    },
    {
      what: 'a kv write',
      write: (kdb: KernelDatabase) => kdb.kernelKVStore.set('k', 'v'),
      sql: SQL_QUERIES.SET,
    },
    {
      what: 'a kv delete',
      write: (kdb: KernelDatabase) => kdb.kernelKVStore.delete('k'),
      sql: SQL_QUERIES.DELETE,
    },
    {
      what: 'a clear',
      write: (kdb: KernelDatabase) => kdb.clear(),
      sql: SQL_QUERIES.CLEAR,
    },
    {
      what: 'a vatstore delete',
      write: (kdb: KernelDatabase) => kdb.deleteVatStore('v1'),
      sql: SQL_QUERIES.DELETE_VS_ALL,
    },
    {
      what: 'a vatstore update',
      write: (kdb: KernelDatabase) =>
        kdb.makeVatStore('v1').updateKVData([['k', 'v']], []),
      sql: SQL_QUERIES.SET_VS,
    },
  ])(
    'refuses $what once the transaction cannot be discarded at all',
    async ({ write, sql }) => {
      const kdb = await makeSQLKernelDatabase({});
      mockDb.inTransaction = true;
      mockDb._spStack = ['t0', 't1'];
      issued = [];

      failOnce.add('ROLLBACK TO SAVEPOINT t1');
      failOnce.add('ROLLBACK TRANSACTION');
      expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

      failOnce.add('ROLLBACK TRANSACTION');
      expect(() => write(kdb)).toThrow('refusing further writes');
      expect(issued).not.toContain(sql);
    },
  );

  it('discards the transaction when the commit fails', async () => {
    const kdb = await makeSQLKernelDatabase({});
    mockDb.inTransaction = true;
    mockDb._spStack = ['t0'];
    issued = [];

    // endCrank: RELEASE SAVEPOINT t0 succeeds, the COMMIT it triggers does not.
    failOnce.add('COMMIT TRANSACTION');
    expect(() => kdb.releaseSavepoint('t0')).toThrow('SQLITE_IOERR');

    // A failed COMMIT can leave the transaction open, and `_spStack` was
    // already spliced empty, so nothing else would have ended it.
    expect(issued).toContain('ROLLBACK TRANSACTION');
    expect(mockDb.inTransaction).toBe(false);
  });

  // SQLite ending the transaction is the only way out of an abort that keeps
  // failing. Refusing writes past that point refuses them forever.
  it('writes again once the transaction it could not end is gone', async () => {
    const kdb = await makeSQLKernelDatabase({});
    mockDb.inTransaction = true;
    mockDb._spStack = ['t0', 't1'];

    failOnce.add('ROLLBACK TO SAVEPOINT t1');
    failOnce.add('ROLLBACK TRANSACTION');
    expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

    mockDb.inTransaction = false;

    issued = [];
    kdb.kernelKVStore.set('k', 'v');
    expect(issued).toStrictEqual([SQL_QUERIES.SET]);
  });

  it('reports the abort that failed while discarding the transaction', async () => {
    const logger = {
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      subLogger: vi.fn(() => logger),
    } as unknown as Logger;
    const kdb = await makeSQLKernelDatabase({ logger });
    mockDb.inTransaction = true;
    mockDb._spStack = ['t0'];

    failOnce.add('COMMIT TRANSACTION');
    failOnce.add('ROLLBACK TRANSACTION');
    expect(() => kdb.releaseSavepoint('t0')).toThrow(
      'SQLITE_IOERR: COMMIT TRANSACTION',
    );

    expect(logger.error).toHaveBeenCalledWith(
      'failed to discard transaction after commit',
      expect.objectContaining({
        message: 'SQLITE_IOERR: ROLLBACK TRANSACTION',
      }),
    );
  });
});
