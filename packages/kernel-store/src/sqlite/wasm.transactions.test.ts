import { describe, it, expect } from 'vitest';

import { initDB, makeSQLKernelDatabase } from './wasm.ts';
import type { KernelDatabase } from '../types.ts';

// Kept out of `wasm.test.ts`, whose `vi.mock` replaces sqlite-wasm for the
// whole file.

const makeDb = async (): Promise<KernelDatabase> =>
  makeSQLKernelDatabase({ dbFilename: ':memory:' });

// The SQLITE_FULL also rolls back any open transaction.
const failWithFullDisk = (kdb: KernelDatabase, write: () => void): void => {
  // SQLite raises a limit below the database's current size to that size.
  kdb.executeQuery('PRAGMA max_page_count = 1');
  expect(write).toThrow('database or disk is full');
  kdb.executeQuery('PRAGMA max_page_count = 1073741823');
};

const tooBig = 'x'.repeat(100_000);

describe('the wasm driver on real SQLite', () => {
  it('undoes the writes a rolled-back savepoint covers', async () => {
    const kdb = await makeDb();
    kdb.kernelKVStore.set('kept', 'before');
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('undone', 'during');
    kdb.kernelKVStore.set('kept', 'during');
    kdb.rollbackSavepoint('t0');

    expect(kdb.kernelKVStore.get('undone')).toBeUndefined();
    expect(kdb.kernelKVStore.get('kept')).toBe('before');
  });

  it('keeps the writes a released savepoint covers', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('key', 'value');
    kdb.releaseSavepoint('t0');

    expect(kdb.kernelKVStore.get('key')).toBe('value');
  });

  it('rolls the inner savepoint back without disturbing the outer one', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('outer', 'yes');
    kdb.createSavepoint('t1');
    kdb.kernelKVStore.set('inner', 'yes');
    kdb.rollbackSavepoint('t1');
    kdb.releaseSavepoint('t0');

    expect(kdb.kernelKVStore.get('outer')).toBe('yes');
    expect(kdb.kernelKVStore.get('inner')).toBeUndefined();
  });

  it('opens a transaction for the outermost savepoint', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('key', 'value');
    // A transaction the `SAVEPOINT` opened ends here; one `BEGIN` opened does not.
    kdb.executeQuery('RELEASE SAVEPOINT t0');

    // SQLite refuses this unless a transaction is open.
    expect(() => kdb.executeQuery('ROLLBACK TRANSACTION')).not.toThrow();
    expect(kdb.kernelKVStore.get('key')).toBeUndefined();
  });

  it.each([
    [
      'kv',
      (kdb: KernelDatabase, value: string) =>
        kdb.kernelKVStore.set('key', value),
      (kdb: KernelDatabase) => kdb.kernelKVStore.get('key'),
    ],
    [
      'vatstore',
      (kdb: KernelDatabase, value: string) =>
        kdb.makeVatStore('v1').updateKVData([['key', value]], []),
      (kdb: KernelDatabase) =>
        new Map(kdb.makeVatStore('v1').getKVData()).get('key'),
    ],
  ])('keeps taking %s writes after one fails', async (_name, write, read) => {
    const kdb = await makeDb();
    failWithFullDisk(kdb, () => write(kdb, tooBig));

    write(kdb, 'value');

    expect(read(kdb)).toBe('value');
  });

  it('reports no transaction once the database is closed', async () => {
    const db = await initDB(':memory:');
    db.exec('BEGIN TRANSACTION');
    expect(db.inTransaction).toBe(true);

    db.close();

    expect(db.inTransaction).toBe(false);
  });

  it('commits a write made after SQLite ends the transaction itself', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    failWithFullDisk(kdb, () => kdb.kernelKVStore.set('key', tooBig));

    kdb.makeVatStore('v1').updateKVData([['key', 'value']], []);

    expect(() => kdb.executeQuery('COMMIT TRANSACTION')).toThrow(
      'cannot commit - no transaction is active',
    );
    expect(kdb.makeVatStore('v1').getKVData()).toStrictEqual([
      ['key', 'value'],
    ]);
  });

  it('frees the database after a COMMIT fails and the transaction rolls back', async () => {
    const kdb = await makeDb();
    // A deferred foreign key fails the COMMIT and leaves the transaction open.
    kdb.executeQuery('PRAGMA foreign_keys = ON');
    kdb.executeQuery('CREATE TABLE parent (id PRIMARY KEY)');
    kdb.executeQuery(
      'CREATE TABLE child (parentId REFERENCES parent (id) DEFERRABLE INITIALLY DEFERRED)',
    );
    kdb.createSavepoint('t0');
    kdb.executeQuery('INSERT INTO child VALUES (1)');
    expect(() => kdb.releaseSavepoint('t0')).toThrow(
      'FOREIGN KEY constraint failed',
    );
    kdb.createSavepoint('t0');
    kdb.rollbackSavepoint('t0');

    expect(() => kdb.executeQuery('DROP TABLE child')).not.toThrow();
  });

  it('takes the next crank in a transaction of its own', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    failWithFullDisk(kdb, () => kdb.kernelKVStore.set('key', tooBig));
    expect(() => kdb.rollbackSavepoint('t0')).toThrow('no such savepoint: t0');

    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('key', 'value');
    kdb.releaseSavepoint('t0');

    expect(kdb.kernelKVStore.get('key')).toBe('value');
  });
});
