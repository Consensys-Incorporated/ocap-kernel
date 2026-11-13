import type { RecordFilter, RecordRow } from '../types.ts';

export const SQL_QUERIES = {
  CREATE_TABLE: `
    CREATE TABLE IF NOT EXISTS kv (
      key TEXT,
      value TEXT,
      PRIMARY KEY(key)
    )
  `,
  CREATE_TABLE_VS: `
    CREATE TABLE IF NOT EXISTS kv_vatstore (
      vatID TEXT,
      key TEXT,
      value TEXT,
      PRIMARY KEY(vatID, key)
    )
  `,
  CREATE_TABLE_RECORDS: `
    CREATE TABLE IF NOT EXISTS records (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      witness TEXT NOT NULL,
      crank INTEGER NOT NULL,
      kref TEXT,
      endpoint TEXT,
      sender TEXT,
      trace TEXT,
      data TEXT NOT NULL
    )
  `,
  CREATE_INDEX_RECORDS_KREF: `
    CREATE INDEX IF NOT EXISTS records_kref ON records (kref, seq)
  `,
  CREATE_INDEX_RECORDS_ENDPOINT: `
    CREATE INDEX IF NOT EXISTS records_endpoint ON records (endpoint, seq)
  `,
  CREATE_INDEX_RECORDS_SENDER: `
    CREATE INDEX IF NOT EXISTS records_sender ON records (sender, seq)
  `,
  CREATE_INDEX_RECORDS_TRACE: `
    CREATE INDEX IF NOT EXISTS records_trace ON records (trace, seq)
  `,
  APPEND_RECORD: `
    INSERT INTO records (kind, witness, crank, kref, endpoint, sender, trace, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `,
  GET: `
    SELECT value
    FROM kv
    WHERE key = ?
  `,
  GET_NEXT: `
    SELECT key
    FROM kv
    WHERE key > ?
    LIMIT 1
  `,
  GET_ALL_VS: `
    SELECT key, value
    FROM kv_vatstore
    WHERE vatID = ?
  `,
  SET: `
    INSERT INTO kv (key, value)
    VALUES (?, ?)
    ON CONFLICT DO UPDATE SET value = excluded.value
  `,
  SET_VS: `
    INSERT INTO kv_vatstore (vatID, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT DO UPDATE SET value = excluded.value
  `,
  DELETE: `
    DELETE FROM kv
    WHERE key = ?
  `,
  DELETE_VS: `
    DELETE FROM kv_vatstore
    WHERE vatID = ? AND key = ?
  `,
  DELETE_VS_ALL: `
    DELETE FROM kv_vatstore
    WHERE vatID = ?
  `,
  CLEAR: `DELETE FROM kv`,
  CLEAR_VS: `DELETE FROM kv_vatstore`,
  CLEAR_RECORDS: `DELETE FROM records`,
  DROP: `DROP TABLE kv`,
  DROP_VS: `DROP TABLE kv_vatstore`,
  BEGIN_TRANSACTION: `BEGIN TRANSACTION`,
  BEGIN_IMMEDIATE_TRANSACTION: `BEGIN IMMEDIATE TRANSACTION`,
  COMMIT_TRANSACTION: `COMMIT TRANSACTION`,
  ABORT_TRANSACTION: `ROLLBACK TRANSACTION`,
  // SQLite's parameter markers (?, ?NNN, :name, @name, $name) can only be used
  // in places where a literal value is allowed. We can't bind identifiers
  // for table names, column names, or savepoint names. We use %NAME% as a
  // placeholder for the savepoint name.
  CREATE_SAVEPOINT: `SAVEPOINT %NAME%`,
  ROLLBACK_SAVEPOINT: `ROLLBACK TO SAVEPOINT %NAME%`,
  RELEASE_SAVEPOINT: `RELEASE SAVEPOINT %NAME%`,
} as const;

/**
 * The default filename for the SQLite database; ":memory:" is an ephemeral in-memory database.
 */
export const DEFAULT_DB_FILENAME = ':memory:';

/**
 * Check if a string is a valid SQLite identifier.
 *
 * @param name - The string to check.
 */
export function assertSafeIdentifier(name: string): void {
  if (!/^[A-Za-z_]\w*$/u.test(name)) {
    throw new Error(`Invalid identifier: ${name}`);
  }
}

/** The columns of a {@link RecordRow}, in the order queries return them. */
export const RECORD_COLUMNS = [
  'seq',
  'kind',
  'witness',
  'crank',
  'kref',
  'endpoint',
  'sender',
  'trace',
  'data',
] as const satisfies (keyof RecordRow)[];

/** A SQL statement with the values to bind to its parameter markers. */
export type BoundStatement = {
  sql: string;
  params: (string | number)[];
};

/**
 * Build the `WHERE` clause selecting the records a filter describes.
 *
 * @param filter - The filter.
 * @returns The clause, empty if the filter selects everything, and its
 * parameters.
 */
function buildRecordsWhere(filter: RecordFilter): BoundStatement {
  const conditions: string[] = [];
  const params: (string | number)[] = [];
  const equal = (column: string, value: string | undefined): void => {
    if (value !== undefined) {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  };
  equal('kind', filter.kind);
  equal('kref', filter.kref);
  equal('endpoint', filter.endpoint);
  equal('sender', filter.sender);
  equal('trace', filter.trace);
  if (filter.involving !== undefined) {
    conditions.push('(endpoint = ? OR sender = ?)');
    params.push(filter.involving, filter.involving);
  }
  if (filter.throughCrank !== undefined) {
    conditions.push('crank <= ?');
    params.push(filter.throughCrank);
  }
  if (filter.afterSeq !== undefined) {
    conditions.push('seq > ?');
    params.push(filter.afterSeq);
  }
  return {
    sql: conditions.length === 0 ? '' : ` WHERE ${conditions.join(' AND ')}`,
    params,
  };
}

/**
 * Build the query reading the records a filter describes, in sequence order.
 *
 * @param filter - The filter.
 * @returns The query.
 */
export function buildRecordsQuery(filter: RecordFilter): BoundStatement {
  const { sql: where, params } = buildRecordsWhere(filter);
  let sql = `SELECT ${RECORD_COLUMNS.join(', ')} FROM records${where} ORDER BY seq`;
  if (filter.limit !== undefined) {
    sql += ' LIMIT ?';
    params.push(filter.limit);
  }
  return { sql, params };
}

/**
 * Build the statement deleting the records a filter describes.
 *
 * @param filter - The filter.
 * @returns The statement.
 */
export function buildRecordsDelete(filter: RecordFilter): BoundStatement {
  const { sql: where, params } = buildRecordsWhere(filter);
  if (filter.limit === undefined) {
    return { sql: `DELETE FROM records${where}`, params };
  }
  // SQLite deletes with `LIMIT` only when built with an option this package's
  // builds may lack, so the limit goes through a subquery.
  return {
    sql: `DELETE FROM records WHERE seq IN (SELECT seq FROM records${where} ORDER BY seq LIMIT ?)`,
    params: [...params, filter.limit],
  };
}

/**
 * Read a record row out of the values of its columns, in
 * {@link RECORD_COLUMNS} order.
 *
 * @param values - The column values.
 * @returns The row.
 */
export function recordRowFromValues(values: unknown[]): RecordRow {
  const [seq, kind, witness, crank, kref, endpoint, sender, trace, data] =
    values as [
      number,
      string,
      string,
      number,
      string | null,
      string | null,
      string | null,
      string | null,
      string,
    ];
  return { seq, kind, witness, crank, kref, endpoint, sender, trace, data };
}
