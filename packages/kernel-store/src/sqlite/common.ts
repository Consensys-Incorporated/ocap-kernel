import type {
  AccountabilityRecordFilter,
  AccountabilityRecordRow,
} from '../types.ts';

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
  CREATE_TABLE_ACCOUNTABILITY_RECORDS: `
    CREATE TABLE IF NOT EXISTS accountability_records (
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
  CREATE_INDEX_ACCOUNTABILITY_RECORDS_KREF: `
    CREATE INDEX IF NOT EXISTS accountability_records_kref ON accountability_records (kref, seq)
  `,
  CREATE_INDEX_ACCOUNTABILITY_RECORDS_ENDPOINT: `
    CREATE INDEX IF NOT EXISTS accountability_records_endpoint ON accountability_records (endpoint, seq)
  `,
  CREATE_INDEX_ACCOUNTABILITY_RECORDS_SENDER: `
    CREATE INDEX IF NOT EXISTS accountability_records_sender ON accountability_records (sender, seq)
  `,
  CREATE_INDEX_ACCOUNTABILITY_RECORDS_TRACE: `
    CREATE INDEX IF NOT EXISTS accountability_records_trace ON accountability_records (trace, seq)
  `,
  APPEND_ACCOUNTABILITY_RECORD: `
    INSERT INTO accountability_records (kind, witness, crank, kref, endpoint, sender, trace, data)
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
  CLEAR_ACCOUNTABILITY_RECORDS: `DELETE FROM accountability_records`,
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

/** The columns of a {@link AccountabilityRecordRow}, in the order queries return them. */
export const ACCOUNTABILITY_RECORD_COLUMNS = [
  'seq',
  'kind',
  'witness',
  'crank',
  'kref',
  'endpoint',
  'sender',
  'trace',
  'data',
] as const satisfies (keyof AccountabilityRecordRow)[];

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
function buildAccountabilityRecordsWhere(
  filter: AccountabilityRecordFilter,
): BoundStatement {
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
  if (filter.crank !== undefined) {
    conditions.push('crank = ?');
    params.push(filter.crank);
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
 * Refuse a limit SQLite would not treat as one: it reads a negative limit as
 * none at all.
 *
 * @param limit - The filter's limit, if any.
 */
function assertLimit(limit: number | undefined): void {
  if (limit !== undefined && !(Number.isInteger(limit) && limit >= 0)) {
    throw new Error(`limit must be a non-negative integer, not ${limit}`);
  }
}

/**
 * Build the query reading the records a filter describes, in sequence order.
 *
 * @param filter - The filter.
 * @returns The query.
 */
export function buildAccountabilityRecordsQuery(
  filter: AccountabilityRecordFilter,
): BoundStatement {
  const { sql: where, params } = buildAccountabilityRecordsWhere(filter);
  assertLimit(filter.limit);
  let sql = `SELECT ${ACCOUNTABILITY_RECORD_COLUMNS.join(', ')} FROM accountability_records${where} ORDER BY seq`;
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
export function buildAccountabilityRecordsDelete(
  filter: AccountabilityRecordFilter,
): BoundStatement {
  const { sql: where, params } = buildAccountabilityRecordsWhere(filter);
  assertLimit(filter.limit);
  if (filter.limit === undefined) {
    return { sql: `DELETE FROM accountability_records${where}`, params };
  }
  // SQLite deletes with `LIMIT` only when built with an option this package's
  // builds may lack, so the limit goes through a subquery.
  return {
    sql: `DELETE FROM accountability_records WHERE seq IN (SELECT seq FROM accountability_records${where} ORDER BY seq LIMIT ?)`,
    params: [...params, filter.limit],
  };
}

/**
 * Read a record row out of the values of its columns, in
 * {@link ACCOUNTABILITY_RECORD_COLUMNS} order.
 *
 * @param values - The column values.
 * @returns The row.
 */
export function accountabilityRecordRowFromValues(
  values: unknown[],
): AccountabilityRecordRow {
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
