import type { Logger } from '@metamask/logger';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { makeSQLKernelDatabase } from './wasm.ts';
import type { KernelDatabase } from '../types.ts';

/**
 * The nodejs sibling of this file states the invariants both drivers owe the
 * crank layer. This one exists because the two drivers reach them over
 * different plumbing: wasm steps prepared statements rather than running them,
 * and its vatstore writes go through `safeMutate` rather than a driver-level
 * transaction helper.
 */

/** Every statement and exec call, in order. */
let issued: string[] = [];
/** SQL that throws when next run. */
let failOnce: Set<string> = new Set();
/** What SQLite would report through `sqlite3_get_autocommit`. */
let txOpen = false;

/**
 * Run one statement against the mock. A statement that throws changes nothing,
 * as in SQLite, so an injected failure leaves the transaction as it was.
 *
 * @param text - The SQL being run.
 */
function runSql(text: string): void {
  issued.push(text);
  if (failOnce.delete(text)) {
    throw new Error(`SQLITE_IOERR: ${text}`);
  }
  if (text === 'BEGIN TRANSACTION') {
    txOpen = true;
  } else if (text === 'COMMIT TRANSACTION' || text === 'ROLLBACK TRANSACTION') {
    if (!txOpen) {
      throw new Error('cannot rollback - no transaction is active');
    }
    txOpen = false;
  }
}

const makeStatement = (text: string): Record<string, unknown> => ({
  bind: vi.fn(),
  step: () => {
    runSql(text);
    return false;
  },
  reset: vi.fn(),
  get: vi.fn(),
  getString: vi.fn(),
  getColumnName: vi.fn(),
  columnCount: 0,
});

const mockDb = {
  prepare: vi.fn((text: string) => makeStatement(text)),
  exec: vi.fn(runSql),
  pointer: 1,
  _spStack: [] as string[],
  close: vi.fn(),
};

const DbMock = vi.fn(function () {
  return mockDb;
});

vi.mock('@sqlite.org/sqlite-wasm', () => ({
  default: vi.fn(async () => ({
    oo1: { OpfsDb: DbMock, DB: DbMock },
    capi: { sqlite3_get_autocommit: () => (txOpen ? 0 : 1) },
  })),
}));
vi.mock('./env.ts', () => ({ getDBFolder: vi.fn(() => 'test-folder') }));

describe('the wasm driver after a failure it tolerates', () => {
  beforeEach(() => {
    issued = [];
    failOnce = new Set();
    txOpen = false;
    mockDb._spStack = [];
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
    expect(txOpen).toBe(false);
    expect(mockDb._spStack).toStrictEqual([]);
  });

  it('leaves a transaction it found open for its owner to discard', async () => {
    const kdb = await makeSQLKernelDatabase({});
    // A crank in progress: the transaction and `t0` are the run loop's.
    txOpen = true;
    mockDb._spStack = ['t0'];
    issued = [];

    failOnce.add('SAVEPOINT t1');
    expect(() => kdb.createSavepoint('t1')).toThrow('SQLITE_IOERR');

    // Discarding here would abort the crank behind its back; it still has `t0`
    // to reach its own rollback through.
    expect(issued).toStrictEqual(['SAVEPOINT t1']);
    expect(txOpen).toBe(true);
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
      txOpen = true;
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

  it('discards the transaction and lets the next savepoint begin its own', async () => {
    const kdb = await makeSQLKernelDatabase({});
    txOpen = true;
    mockDb._spStack = ['t0', 't1'];
    issued = [];

    failOnce.add('ROLLBACK TO SAVEPOINT t1');
    failOnce.add('ROLLBACK TRANSACTION');
    expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

    issued = [];
    kdb.createSavepoint('teardown');
    kdb.releaseSavepoint('teardown');

    // The abort is retried and succeeds, so what the COMMIT makes durable is
    // `teardown`'s own transaction and not the crank that was thrown away.
    expect(issued).toStrictEqual([
      'ROLLBACK TRANSACTION',
      'BEGIN TRANSACTION',
      'SAVEPOINT teardown',
      'RELEASE SAVEPOINT teardown',
      'COMMIT TRANSACTION',
    ]);
  });

  // SQLite having ended the transaction leaves the driver's savepoints gone
  // and its ROLLBACK refused, which it must not read as a transaction it could
  // not end: that refuses every write from here on.
  it('keeps writing after SQLite rolls the transaction back itself', async () => {
    const kdb = await makeSQLKernelDatabase({});
    txOpen = true;
    mockDb._spStack = ['t0', 't1'];

    failOnce.add('ROLLBACK TO SAVEPOINT t1');
    txOpen = false;
    expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

    issued = [];
    kdb.kernelKVStore.set('k', 'v');
    expect(issued).toStrictEqual([SQL_QUERIES.SET]);
  });

  // SQLite ending the transaction is also the only way out of an abort that
  // keeps failing. Refusing writes past that point refuses them forever.
  it('writes again once the transaction it could not end is gone', async () => {
    const kdb = await makeSQLKernelDatabase({});
    txOpen = true;
    mockDb._spStack = ['t0', 't1'];

    failOnce.add('ROLLBACK TO SAVEPOINT t1');
    failOnce.add('ROLLBACK TRANSACTION');
    expect(() => kdb.rollbackSavepoint('t1')).toThrow('SQLITE_IOERR');

    txOpen = false;

    issued = [];
    kdb.kernelKVStore.set('k', 'v');
    expect(issued).toStrictEqual([SQL_QUERIES.SET]);
  });

  // A savepoint left on the stack keeps the transaction open with nothing to
  // commit or abort it, so every later write joins it and vanishes on close.
  it.each([
    {
      what: 'a savepoint rollback',
      act: (kdb: KernelDatabase) => kdb.rollbackSavepoint('t0'),
      failing: 'ROLLBACK TO SAVEPOINT t0',
    },
    {
      what: 'a savepoint release',
      act: (kdb: KernelDatabase) => kdb.releaseSavepoint('t0'),
      failing: 'RELEASE SAVEPOINT t0',
    },
    {
      what: 'a commit',
      act: (kdb: KernelDatabase) => kdb.releaseSavepoint('t0'),
      failing: 'COMMIT TRANSACTION',
    },
  ])('discards the transaction when $what fails', async ({ act, failing }) => {
    const kdb = await makeSQLKernelDatabase({});
    txOpen = true;
    mockDb._spStack = ['t0'];
    issued = [];

    failOnce.add(failing);
    expect(() => act(kdb)).toThrow(`SQLITE_IOERR: ${failing}`);

    expect(issued.at(-1)).toBe('ROLLBACK TRANSACTION');
    expect(txOpen).toBe(false);
    expect(mockDb._spStack).toStrictEqual([]);
  });

  // The first failure is the diagnosis; a failed abort on top of it only
  // repeats that the same connection is broken.
  it.each([
    {
      what: 'a savepoint rollback',
      act: (kdb: KernelDatabase) => kdb.rollbackSavepoint('t0'),
      failing: 'ROLLBACK TO SAVEPOINT t0',
      after: 'rollback',
    },
    {
      what: 'a savepoint release',
      act: (kdb: KernelDatabase) => kdb.releaseSavepoint('t0'),
      failing: 'RELEASE SAVEPOINT t0',
      after: 'release',
    },
    {
      what: 'a commit',
      act: (kdb: KernelDatabase) => kdb.releaseSavepoint('t0'),
      failing: 'COMMIT TRANSACTION',
      after: 'commit',
    },
  ])(
    'reports the failure in $what rather than the abort that followed it',
    async ({ act, failing, after }) => {
      const logger = {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      const kdb = await makeSQLKernelDatabase({ logger });
      txOpen = true;
      mockDb._spStack = ['t0'];

      failOnce.add(failing);
      failOnce.add('ROLLBACK TRANSACTION');
      expect(() => act(kdb)).toThrow(`SQLITE_IOERR: ${failing}`);

      expect(logger.error).toHaveBeenCalledWith(
        `failed to discard transaction after ${after}`,
        expect.objectContaining({
          message: 'SQLITE_IOERR: ROLLBACK TRANSACTION',
        }),
      );
      // A stack left populated makes `commitIfNeeded`'s "savepoints remain"
      // early return permanent: the driver goes on accepting writes, begins a
      // transaction for them, and never commits.
      expect(mockDb._spStack).toStrictEqual([]);
    },
  );
});
