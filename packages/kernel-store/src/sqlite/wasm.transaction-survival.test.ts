import { describe, it, expect, beforeEach, vi } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { makeSQLKernelDatabase } from './wasm.ts';
import type { KernelDatabase } from '../types.ts';

/**
 * The nodejs sibling of this file states the invariants both drivers owe the
 * crank layer. This one exists because the two drivers reach them differently:
 * where nodejs asks SQLite whether a transaction is open, wasm caches the
 * answer in `_inTx`, and its vatstore writes go through `safeMutate` rather
 * than a driver-level transaction helper.
 */

/** Every statement and exec call, in order. */
let issued: string[] = [];
/** SQL that throws when next run. */
let failOnce: Set<string> = new Set();

/**
 * Run one statement against the mock. A statement that throws changes nothing,
 * as in SQLite; the driver keeps its own view of the transaction in `_inTx`,
 * which is the thing under test and so must not be modelled here.
 *
 * @param text - The SQL being run.
 */
function runSql(text: string): void {
  issued.push(text);
  if (failOnce.delete(text)) {
    throw new Error(`SQLITE_IOERR: ${text}`);
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
  _inTx: false,
  _spStack: [] as string[],
  close: vi.fn(),
};

const DbMock = vi.fn(function () {
  return mockDb;
});

vi.mock('@sqlite.org/sqlite-wasm', () => ({
  default: vi.fn(async () => ({ oo1: { OpfsDb: DbMock, DB: DbMock } })),
}));
vi.mock('./env.ts', () => ({ getDBFolder: vi.fn(() => 'test-folder') }));

describe('the wasm driver after a failure it tolerates', () => {
  beforeEach(() => {
    issued = [];
    failOnce = new Set();
    mockDb._inTx = false;
    mockDb._spStack = [];
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
      mockDb._inTx = true;
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
    mockDb._inTx = true;
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
});
