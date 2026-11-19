import { describe, it, expect } from 'vitest';

import {
  SQL_QUERIES,
  assertSafeIdentifier,
  buildAccountabilityRecordsDelete,
  buildAccountabilityRecordsQuery,
  accountabilityRecordRowFromValues,
} from './common.ts';

describe('SQL_QUERIES', () => {
  // XXX Is this test actually useful? It's basically testing that the source code matches itself.
  it.each([
    [
      'CREATE_TABLE',
      'CREATE TABLE IF NOT EXISTS kv ( key TEXT, value TEXT, PRIMARY KEY(key) )',
      'creates a key-value table with proper schema',
    ],
    ['GET', 'SELECT value FROM kv WHERE key = ?', 'retrieves a value by key'],
    [
      'GET_NEXT',
      'SELECT key FROM kv WHERE key > ? LIMIT 1',
      'gets the next key in sequence',
    ],
    [
      'SET',
      'INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT DO UPDATE SET value = excluded.value',
      'inserts or updates a key-value pair',
    ],
    [
      'DELETE',
      'DELETE FROM kv WHERE key = ?',
      'deletes a specific key-value pair',
    ],
    ['CLEAR', 'DELETE FROM kv', 'deletes all key-value pairs'],
    ['DROP', 'DROP TABLE kv', 'drops the entire table'],
  ] as const)(
    'has the expected %s query (%s)',
    (queryName, expectedSql, _description) => {
      expect(SQL_QUERIES[queryName].trim().replace(/\s+/gu, ' ')).toBe(
        expectedSql,
      );
    },
  );

  it('has all expected query properties', () => {
    expect(Object.keys(SQL_QUERIES).sort()).toStrictEqual([
      'ABORT_TRANSACTION',
      'APPEND_ACCOUNTABILITY_RECORD',
      'BEGIN_IMMEDIATE_TRANSACTION',
      'BEGIN_TRANSACTION',
      'CLEAR',
      'CLEAR_ACCOUNTABILITY_RECORDS',
      'CLEAR_VS',
      'COMMIT_TRANSACTION',
      'CREATE_INDEX_ACCOUNTABILITY_RECORDS_CRANK',
      'CREATE_INDEX_ACCOUNTABILITY_RECORDS_ENDPOINT',
      'CREATE_INDEX_ACCOUNTABILITY_RECORDS_KREF',
      'CREATE_INDEX_ACCOUNTABILITY_RECORDS_SENDER',
      'CREATE_INDEX_ACCOUNTABILITY_RECORDS_TRACE',
      'CREATE_SAVEPOINT',
      'CREATE_TABLE',
      'CREATE_TABLE_ACCOUNTABILITY_RECORDS',
      'CREATE_TABLE_VS',
      'DELETE',
      'DELETE_VS',
      'DELETE_VS_ALL',
      'DROP',
      'DROP_VS',
      'GET',
      'GET_ALL_VS',
      'GET_NEXT',
      'RELEASE_SAVEPOINT',
      'ROLLBACK_SAVEPOINT',
      'SET',
      'SET_VS',
    ]);
  });
});

describe('assertSafeIdentifier', () => {
  it('accepts valid SQL identifiers', () => {
    expect(() => assertSafeIdentifier('valid')).not.toThrow();
    expect(() => assertSafeIdentifier('Valid')).not.toThrow();
    expect(() => assertSafeIdentifier('valid_name')).not.toThrow();
    expect(() => assertSafeIdentifier('valid_name_123')).not.toThrow();
    expect(() => assertSafeIdentifier('_leading_underscore')).not.toThrow();
  });

  it('rejects invalid SQL identifiers', () => {
    // Starting with a number
    expect(() => assertSafeIdentifier('123invalid')).toThrow(
      'Invalid identifier',
    );

    // Containing invalid characters
    expect(() => assertSafeIdentifier('invalid-name')).toThrow(
      'Invalid identifier',
    );
    expect(() => assertSafeIdentifier('invalid.name')).toThrow(
      'Invalid identifier',
    );
    expect(() => assertSafeIdentifier('invalid;name')).toThrow(
      'Invalid identifier',
    );
    expect(() => assertSafeIdentifier('invalid name')).toThrow(
      'Invalid identifier',
    );

    // Containing SQL injection attempts
    expect(() => assertSafeIdentifier("name'; DROP TABLE users--")).toThrow(
      'Invalid identifier',
    );
  });
});

describe('buildAccountabilityRecordsQuery', () => {
  it('selects every record in sequence order when given no conditions', () => {
    expect(buildAccountabilityRecordsQuery({})).toStrictEqual({
      sql: 'SELECT seq, kind, witness, crank, kref, endpoint, sender, trace, data FROM accountability_records ORDER BY seq',
      params: [],
    });
  });

  it('binds one parameter per condition, in clause order', () => {
    expect(
      buildAccountabilityRecordsQuery({
        kind: 'delivery',
        kref: 'ko1',
        endpoint: 'v1',
        sender: 'v2',
        trace: 't1',
        involving: 'v3',
        crank: 4,
        throughCrank: 7,
        afterSeq: 3,
        limit: 10,
      }),
    ).toStrictEqual({
      sql: 'SELECT seq, kind, witness, crank, kref, endpoint, sender, trace, data FROM accountability_records WHERE kind = ? AND kref = ? AND endpoint = ? AND sender = ? AND trace = ? AND (endpoint = ? OR sender = ?) AND crank = ? AND crank <= ? AND seq > ? ORDER BY seq LIMIT ?',
      params: ['delivery', 'ko1', 'v1', 'v2', 't1', 'v3', 'v3', 4, 7, 3, 10],
    });
  });
});

describe('buildAccountabilityRecordsDelete', () => {
  it('deletes what the conditions select', () => {
    expect(
      buildAccountabilityRecordsDelete({ kref: 'ko1', throughCrank: 5 }),
    ).toStrictEqual({
      sql: 'DELETE FROM accountability_records WHERE kref = ? AND crank <= ?',
      params: ['ko1', 5],
    });
  });

  it.each([-1, 1.5, Number.NaN])(
    'refuses the limit %s in a query and a delete',
    (limit) => {
      expect(() => buildAccountabilityRecordsQuery({ limit })).toThrow(
        'limit must be a non-negative integer',
      );
      expect(() => buildAccountabilityRecordsDelete({ limit })).toThrow(
        'limit must be a non-negative integer',
      );
    },
  );

  it('applies a limit through a subquery, earliest first', () => {
    expect(
      buildAccountabilityRecordsDelete({ kind: 'delivery', limit: 2 }),
    ).toStrictEqual({
      sql: 'DELETE FROM accountability_records WHERE seq IN (SELECT seq FROM accountability_records WHERE kind = ? ORDER BY seq LIMIT ?)',
      params: ['delivery', 2],
    });
  });
});

describe('accountabilityRecordRowFromValues', () => {
  it('names the columns in query order', () => {
    expect(
      accountabilityRecordRowFromValues([
        3,
        'delivery',
        'kernel',
        7,
        'ko1',
        'v1',
        null,
        null,
        '{}',
      ]),
    ).toStrictEqual({
      seq: 3,
      kind: 'delivery',
      witness: 'kernel',
      crank: 7,
      kref: 'ko1',
      endpoint: 'v1',
      sender: null,
      trace: null,
      data: '{}',
    });
  });
});
