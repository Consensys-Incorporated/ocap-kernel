import type { Logger } from '@metamask/logger';
import type { Sqlite3Static } from '@sqlite.org/sqlite-wasm';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { SQL_QUERIES } from './common.ts';
import { getDBFolder } from './env.ts';
import { makeSQLKernelDatabase } from './wasm.ts';
import type { KernelDatabase } from '../types.ts';

const mockKVData = [
  { key: 'key1', value: 'value1' },
  { key: 'key2', value: 'value2' },
] as const;

const mockKVDataForMap: [string, string][] = [
  ['key1', 'value1'],
  ['key2', 'value2'],
];

const makeMockStatement = () => ({
  bind: vi.fn(),
  step: vi.fn(),
  getString: vi.fn(),
  reset: vi.fn(),
  get: vi.fn(),
  getColumnName: vi.fn(),
  columnCount: 2,
});

const mockStatement = makeMockStatement();
const mockBegin = makeMockStatement();
const mockCommit = makeMockStatement();
const mockAbort = makeMockStatement();

// The driver asks SQLite whether a transaction is open, so the mock answers as
// SQLite would: stepping BEGIN, COMMIT or ABORT moves `txOpen`, which
// `sqlite3_get_autocommit` reports.
let txOpen = false;

const resetStatements = (): void => {
  [mockStatement, mockBegin, mockCommit, mockAbort].forEach((statement) =>
    Object.values(statement).forEach((value) => {
      if (typeof value === 'function') {
        value.mockReset();
      }
    }),
  );
  mockBegin.step.mockImplementation(() => {
    txOpen = true;
    return false;
  });
  mockCommit.step.mockImplementation(() => {
    txOpen = false;
    return false;
  });
  mockAbort.step.mockImplementation(() => {
    txOpen = false;
    return false;
  });
};
resetStatements();

// `initDB` installs `inTransaction` with `Object.defineProperty`, so each call
// needs a database it has not defined it on yet.
const makeMockDb = () => ({
  exec: vi.fn(),
  prepare: vi.fn((sql: string) => {
    switch (sql) {
      case SQL_QUERIES.BEGIN_TRANSACTION:
        return mockBegin;
      case SQL_QUERIES.COMMIT_TRANSACTION:
        return mockCommit;
      case SQL_QUERIES.ABORT_TRANSACTION:
        return mockAbort;
      default:
        return mockStatement;
    }
  }),

  pointer: 1,

  _spStack: [] as string[],
  close: vi.fn(),
});

let mockDb = makeMockDb();

const resetMocks = (): void => {
  mockDb = makeMockDb();
  txOpen = false;
  resetStatements();
};
const OpfsDbMock = vi.fn(function () {
  return mockDb;
});
const DBMock = vi.fn(function () {
  return mockDb;
});
const mockCapi = { sqlite3_get_autocommit: () => (txOpen ? 0 : 1) };
vi.mock('@sqlite.org/sqlite-wasm', () => ({
  default: vi.fn(async () => ({
    capi: mockCapi,
    oo1: {
      OpfsDb: OpfsDbMock,
      DB: DBMock,
    },
  })),
}));

vi.mock('./env.ts', () => ({
  getDBFolder: vi.fn(() => 'test-folder'),
}));

describe('makeSQLKernelDatabase', () => {
  beforeEach(resetMocks);

  it('initializes with OPFS when available', async () => {
    await makeSQLKernelDatabase({});
    expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
  });

  it('falls back to in-memory when OPFS is not available', async () => {
    vi.mocked(
      await import('@sqlite.org/sqlite-wasm'),
    ).default.mockImplementationOnce(
      async () =>
        ({
          capi: mockCapi,
          oo1: {
            OpfsDb: undefined,
            DB: vi.fn(function () {
              return mockDb;
            }),
          },
        }) as unknown as Sqlite3Static,
    );
    const logger = {
      warn: vi.fn(),
      debug: vi.fn(),
      subLogger: vi.fn(() => logger),
    } as unknown as Logger;
    await makeSQLKernelDatabase({ logger });
    expect(logger.warn).toHaveBeenCalledWith(
      'OPFS not enabled, database will be ephemeral',
    );
    expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
  });

  it('get retrieves a value by key', async () => {
    const mockValue = 'test-value';
    mockStatement.step.mockReturnValueOnce(true);
    mockStatement.getString.mockReturnValueOnce(mockValue);
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    const result = store.get('test-key');
    expect(result).toBe(mockValue);
    expect(mockStatement.bind).toHaveBeenCalledWith(['test-key']);
  });

  it('getRequired throws when key not found', async () => {
    mockStatement.step.mockReturnValueOnce(false);
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    expect(() => store.getRequired('missing-key')).toThrowError(
      "no record matching key 'missing-key'",
    );
  });

  it('set inserts or updates a value', async () => {
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    store.set('test-key', 'test-value');
    expect(mockStatement.bind).toHaveBeenCalledWith(['test-key', 'test-value']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('delete removes a key-value pair', async () => {
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    store.delete('test-key');
    expect(mockStatement.bind).toHaveBeenCalledWith(['test-key']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('clear removes all entries', async () => {
    const store = await makeSQLKernelDatabase({});
    store.clear();
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('getNextKey returns the next key in sequence', async () => {
    const mockNextKey = 'next-key';
    mockStatement.step.mockReturnValueOnce(true);
    mockStatement.getString.mockReturnValueOnce(mockNextKey);
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    const result = store.getNextKey('current-key');
    expect(result).toBe(mockNextKey);
    expect(mockStatement.bind).toHaveBeenCalledWith(['current-key']);
  });

  it('makeVatStore returns a VatStore', async () => {
    const db = await makeSQLKernelDatabase({});
    const vatStore = db.makeVatStore('vvat');
    expect(Object.keys(vatStore).sort()).toStrictEqual([
      'getKVData',
      'updateKVData',
    ]);
  });

  it('vatStore.getKVData returns a map of the data', async () => {
    const db = await makeSQLKernelDatabase({});
    const vatStore = db.makeVatStore('vvat');
    mockStatement.step
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockStatement.getString
      .mockReturnValueOnce(mockKVData[0].key)
      .mockReturnValueOnce(mockKVData[0].value)
      .mockReturnValueOnce(mockKVData[1].key)
      .mockReturnValueOnce(mockKVData[1].value);
    const data = vatStore.getKVData();
    expect(data).toStrictEqual([...mockKVDataForMap]);
  });

  it('vatStore.updateKVData updates the database', async () => {
    const db = await makeSQLKernelDatabase({});
    const vatStore = db.makeVatStore('vvat');
    vatStore.updateKVData([...mockKVDataForMap], ['del1', 'del2']);
    // begin transaction
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
    // set
    expect(mockStatement.bind).toHaveBeenCalledWith(['vvat', 'key1', 'value1']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
    // set
    expect(mockStatement.bind).toHaveBeenCalledWith(['vvat', 'key2', 'value2']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
    // delete
    expect(mockStatement.bind).toHaveBeenCalledWith(['vvat', 'del1']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
    // delete
    expect(mockStatement.bind).toHaveBeenCalledWith(['vvat', 'del2']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
    // commit transaction
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('executeQuery executes arbitrary SQL queries', async () => {
    mockStatement.step
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);
    mockStatement.getColumnName
      .mockReturnValueOnce('id')
      .mockReturnValueOnce('value')
      .mockReturnValueOnce('id')
      .mockReturnValueOnce('value');
    mockStatement.get
      .mockReturnValueOnce('1')
      .mockReturnValueOnce('first')
      .mockReturnValueOnce('2')
      .mockReturnValueOnce('second');
    const store = await makeSQLKernelDatabase({});
    const results = store.executeQuery('SELECT * FROM kv');
    expect(results).toStrictEqual([
      { id: '1', value: 'first' },
      { id: '2', value: 'second' },
    ]);
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('get returns undefined when step() returns false', async () => {
    mockStatement.step.mockReturnValueOnce(false);
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    const result = store.get('test-key');
    expect(result).toBeUndefined();
    expect(mockStatement.bind).toHaveBeenCalledWith(['test-key']);
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('get returns undefined when getString() returns falsy value', async () => {
    mockStatement.step.mockReturnValueOnce(true);
    mockStatement.getString.mockReturnValueOnce('');
    const db = await makeSQLKernelDatabase({});
    const store = db.kernelKVStore;
    const result = store.get('test-key');
    expect(result).toBeUndefined();
    expect(mockStatement.bind).toHaveBeenCalledWith(['test-key']);
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('executeQuery skips columns with null/undefined names', async () => {
    mockStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockStatement.getColumnName
      .mockReturnValueOnce('id')
      .mockReturnValueOnce(null)
      .mockReturnValueOnce(undefined);
    mockStatement.get
      .mockReturnValueOnce('1')
      .mockReturnValueOnce('ignored')
      .mockReturnValueOnce('also-ignored');
    const store = await makeSQLKernelDatabase({});
    const results = store.executeQuery('SELECT * FROM kv');
    expect(results).toStrictEqual([{ id: '1' }]);
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('executeQuery handles non-string values by converting them to strings', async () => {
    mockStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockStatement.getColumnName
      .mockReturnValueOnce('id')
      .mockReturnValueOnce('number');
    mockStatement.get.mockReturnValueOnce('1').mockReturnValueOnce(42);
    const store = await makeSQLKernelDatabase({});
    const results = store.executeQuery('SELECT * FROM kv');
    expect(results).toStrictEqual([
      {
        id: '1',
        number: '42',
      },
    ]);
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  describe('KVStore operations', () => {
    it('getNextKey returns undefined when no next key exists', async () => {
      mockStatement.step.mockReturnValueOnce(false);
      const db = await makeSQLKernelDatabase({});
      const store = db.kernelKVStore;
      const result = store.getNextKey('last-key');
      expect(result).toBeUndefined();
      expect(mockStatement.bind).toHaveBeenCalledWith(['last-key']);
      expect(mockStatement.reset).toHaveBeenCalled();
    });

    it('getNextKey returns undefined when getString returns falsy', async () => {
      mockStatement.step.mockReturnValueOnce(true);
      mockStatement.getString.mockReturnValueOnce('');
      const db = await makeSQLKernelDatabase({});
      const store = db.kernelKVStore;
      const result = store.getNextKey('current-key');
      expect(result).toBeUndefined();
      expect(mockStatement.bind).toHaveBeenCalledWith(['current-key']);
      expect(mockStatement.reset).toHaveBeenCalled();
    });
  });

  describe('initialization options', () => {
    it('should use custom dbFilename when provided', async () => {
      const customFilename = 'custom.db';
      await makeSQLKernelDatabase({ dbFilename: customFilename });
      expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
    });

    it('refuses a sqlite3 build without sqlite3_get_autocommit', async () => {
      vi.mocked(
        await import('@sqlite.org/sqlite-wasm'),
      ).default.mockImplementationOnce(
        async () =>
          ({
            capi: {},
            oo1: { OpfsDb: OpfsDbMock, DB: DBMock },
          }) as unknown as Sqlite3Static,
      );

      await expect(makeSQLKernelDatabase({})).rejects.toThrow(
        'sqlite3 capi lacks sqlite3_get_autocommit',
      );
    });

    it('should log if logger is provided', async () => {
      const logger = {
        debug: vi.fn(),
        subLogger: vi.fn(() => logger),
      } as unknown as Logger;
      await makeSQLKernelDatabase({ logger });
      expect(logger.debug).toHaveBeenCalledWith('Initializing kernel store');
    });
  });

  describe('database path construction', () => {
    beforeEach(() => {
      vi.mocked(getDBFolder).mockClear();
    });

    it('should preserve special filenames starting with ":"', async () => {
      await makeSQLKernelDatabase({ dbFilename: ':memory:' });
      expect(getDBFolder).not.toHaveBeenCalled();
      expect(OpfsDbMock).toHaveBeenCalledWith(':memory:', 'cw');
      expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
    });

    it('should construct proper path with folder for regular filenames', async () => {
      const regularFilename = 'test.db';
      await makeSQLKernelDatabase({ dbFilename: regularFilename });
      expect(getDBFolder).toHaveBeenCalled();
      expect(OpfsDbMock).toHaveBeenCalledWith(
        `ocap-test-folder-${regularFilename}`,
        'cw',
      );
      expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
    });

    it('should handle empty folder path', async () => {
      vi.mocked(getDBFolder).mockReturnValueOnce('');
      const regularFilename = 'test.db';
      await makeSQLKernelDatabase({ dbFilename: regularFilename });
      expect(getDBFolder).toHaveBeenCalled();
      expect(OpfsDbMock).toHaveBeenCalledWith(`ocap-${regularFilename}`, 'cw');
      expect(mockDb.exec).toHaveBeenCalledWith(SQL_QUERIES.CREATE_TABLE);
    });
  });

  describe('error handling', () => {
    it('should handle SQL execution errors', async () => {
      const db = await makeSQLKernelDatabase({});
      mockStatement.step.mockImplementationOnce(() => {
        throw new Error('SQL execution error');
      });
      expect(() => db.executeQuery('SELECT * FROM invalid_table')).toThrowError(
        'SQL execution error',
      );
      expect(mockStatement.reset).toHaveBeenCalled();
    });
  });

  describe('savepoint functionality', () => {
    beforeEach(resetMocks);

    it('runs the transaction statements it prepared', async () => {
      const db = await makeSQLKernelDatabase({});

      db.createSavepoint('t0');
      expect(mockBegin.step).toHaveBeenCalledOnce();
      expect(mockBegin.reset).toHaveBeenCalledOnce();
      expect(mockDb.exec).toHaveBeenCalledWith('SAVEPOINT t0');

      db.releaseSavepoint('t0');
      expect(mockDb.exec).toHaveBeenCalledWith('RELEASE SAVEPOINT t0');
      expect(mockCommit.step).toHaveBeenCalledOnce();
      expect(mockCommit.reset).toHaveBeenCalledOnce();

      db.createSavepoint('t1');
      db.rollbackSavepoint('t1');
      expect(mockDb.exec).toHaveBeenCalledWith('ROLLBACK TO SAVEPOINT t1');
      expect(mockAbort.step).toHaveBeenCalledOnce();
      expect(mockAbort.reset).toHaveBeenCalledOnce();
    });
  });

  it('deleteVatStore removes all data for a given vat', async () => {
    Object.values(mockStatement).forEach((mock) => {
      if (typeof mock === 'function' && mock.mockReset) {
        mock.mockReset();
      }
    });
    const db = await makeSQLKernelDatabase({});
    const vatId = 'test-vat';
    db.deleteVatStore(vatId);
    expect(mockDb.prepare).toHaveBeenCalledWith(SQL_QUERIES.DELETE_VS_ALL);
    expect(mockStatement.bind).toHaveBeenCalledWith([vatId]);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it('deleteVatStore handles errors correctly', async () => {
    Object.values(mockStatement).forEach((mock) => {
      if (typeof mock === 'function' && mock.mockReset) {
        mock.mockReset();
      }
    });
    mockStatement.step.mockImplementationOnce(() => {
      throw new Error('Database error');
    });
    const db = await makeSQLKernelDatabase({});
    expect(() => db.deleteVatStore('test-vat')).toThrowError('Database error');
    expect(mockStatement.bind).toHaveBeenCalled();
    expect(mockStatement.reset).not.toHaveBeenCalled();
  });

  it('deleteVatStore handles empty vatId correctly', async () => {
    Object.values(mockStatement).forEach((mock) => {
      if (typeof mock === 'function' && mock.mockReset) {
        mock.mockReset();
      }
    });

    const db = await makeSQLKernelDatabase({});
    db.deleteVatStore('');
    expect(mockStatement.bind).toHaveBeenCalledWith(['']);
    expect(mockStatement.step).toHaveBeenCalled();
    expect(mockStatement.reset).toHaveBeenCalled();
  });

  it("deleteVatStore doesn't affect other vat stores", async () => {
    Object.values(mockStatement).forEach((mock) => {
      if (typeof mock === 'function' && mock.mockReset) {
        mock.mockReset();
      }
    });

    const db = await makeSQLKernelDatabase({});
    db.makeVatStore('vat1');
    const vatStore2 = db.makeVatStore('vat2');
    db.deleteVatStore('vat1');
    mockStatement.step.mockReturnValueOnce(true).mockReturnValueOnce(false);
    mockStatement.getString
      .mockReturnValueOnce('testKey')
      .mockReturnValueOnce('testValue');

    const data = vatStore2.getKVData();
    expect(mockStatement.bind).toHaveBeenCalledWith(['vat2']);
    expect(data).toStrictEqual([['testKey', 'testValue']]);
  });
});

describe('transaction management', () => {
  beforeEach(resetMocks);

  it('safeMutate rollbacks transaction on error', async () => {
    const db = await makeSQLKernelDatabase({});
    txOpen = false;
    mockDb._spStack = [];
    mockStatement.step.mockImplementationOnce(() => {
      throw new Error('Database error');
    });
    const vatStore = db.makeVatStore('test-vat');
    expect(() => vatStore.updateKVData([['key', 'value']], [])).toThrowError(
      'Database error',
    );
    expect(mockAbort.step).toHaveBeenCalled();
    expect(txOpen).toBe(false);
  });

  it('reports the write failure, not a rollback with nothing to undo', async () => {
    const db = await makeSQLKernelDatabase({});
    mockStatement.step.mockImplementationOnce(() => {
      // SQLite ends the transaction as it fails the write.
      txOpen = false;
      throw new Error('database or disk is full');
    });
    mockAbort.step.mockImplementation(() => {
      throw new Error('cannot rollback - no transaction is active');
    });

    expect(() =>
      db.makeVatStore('test-vat').updateKVData([['key', 'value']], []),
    ).toThrowError('database or disk is full');
  });

  it('safeMutate does not commit if already in transaction', async () => {
    const db = await makeSQLKernelDatabase({});
    txOpen = true;
    mockDb._spStack = [];
    const vatStore = db.makeVatStore('test-vat');
    vatStore.updateKVData([['key', 'value']], []);
    expect(mockBegin.step).not.toHaveBeenCalled();
    expect(mockCommit.step).not.toHaveBeenCalled();
  });

  // The store's write doors all have to ask, because teardown after the run
  // loop dies reaches most of them without going near `beginIfNeeded`.
  describe('a transaction no abort can end', () => {
    const abandon = async (): Promise<KernelDatabase> => {
      const kdb = await makeSQLKernelDatabase({});
      kdb.createSavepoint('t0');
      mockDb.exec.mockImplementationOnce(() => {
        throw new Error('SQLITE_IOERR');
      });
      mockAbort.step.mockImplementation(() => {
        throw new Error('SQLITE_IOERR');
      });
      expect(() => kdb.rollbackSavepoint('t0')).toThrow('SQLITE_IOERR');
      return kdb;
    };

    it.each([
      {
        what: 'a kv write',
        write: (kdb: KernelDatabase) => kdb.kernelKVStore.set('k', 'v'),
      },
      {
        what: 'a kv delete',
        write: (kdb: KernelDatabase) => kdb.kernelKVStore.delete('k'),
      },
      { what: 'a clear', write: (kdb: KernelDatabase) => kdb.clear() },
      {
        what: 'a vatstore delete',
        write: (kdb: KernelDatabase) => kdb.deleteVatStore('v1'),
      },
      {
        what: 'a vatstore update',
        write: (kdb: KernelDatabase) =>
          kdb.makeVatStore('v1').updateKVData([['k', 'v']], []),
      },
    ])('refuses $what', async ({ write }) => {
      const kdb = await abandon();
      mockStatement.step.mockClear();

      expect(() => write(kdb)).toThrow('refusing further writes');
      expect(mockStatement.step).not.toHaveBeenCalled();
    });
  });

  describe('close functionality', () => {
    it('closes the database', async () => {
      const db = await makeSQLKernelDatabase({});
      db.close();
      expect(mockDb.close).toHaveBeenCalled();
    });
  });
});
