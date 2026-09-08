import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { makeSQLKernelDatabase } from './nodejs.ts';
import type { KernelDatabase } from '../types.ts';

/**
 * Two invariants the crank layer relies on:
 *
 * - a failed `ROLLBACK TO` discards the whole transaction, so truncating
 *   `ctx.savepoints` to zero still matches the database;
 * - `commitIfNeeded` leaves no transaction behind.
 *
 * Both drivers catch and log an abort that fails while discarding a transaction,
 * so "the whole transaction is discarded" holds only when that abort succeeds.
 * This driver has no `_inTx` flag, reading `db.inTransaction` from SQLite
 * instead, which prevents a wedged flag but does not by itself end an ownerless
 * transaction.
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
});
