import { describe, it, expect } from 'vitest';

import { initDB, makeSQLKernelDatabase } from './wasm.ts';
import type { KernelDatabase } from '../types.ts';

// The wasm driver against the real SQLite build. Its siblings mock the database
// to inject I/O failures; this file exists for the savepoint and transaction
// semantics only SQLite itself can state.

const makeDb = async (): Promise<KernelDatabase> =>
  makeSQLKernelDatabase({ dbFilename: ':memory:' });

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

    // SQLite refuses this unless a transaction is open.
    expect(() => kdb.executeQuery('ROLLBACK TRANSACTION')).not.toThrow();
    expect(kdb.kernelKVStore.get('key')).toBeUndefined();
  });

  // `ROLLBACK TRANSACTION` stands in for what SQLITE_FULL leaves behind: the
  // transaction and every savepoint in it are gone.
  it('keeps writing after SQLite ends the transaction itself', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('lost', 'value');
    kdb.executeQuery('ROLLBACK TRANSACTION');

    expect(() => kdb.rollbackSavepoint('t0')).toThrow('no such savepoint: t0');

    kdb.kernelKVStore.set('after', 'value');
    expect(kdb.kernelKVStore.get('after')).toBe('value');
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
    kdb.executeQuery('ROLLBACK TRANSACTION');

    kdb.makeVatStore('v1').updateKVData([['key', 'value']], []);

    expect(() => kdb.executeQuery('COMMIT TRANSACTION')).toThrow(
      'cannot commit - no transaction is active',
    );
  });

  it('takes the next crank in a transaction of its own', async () => {
    const kdb = await makeDb();
    kdb.createSavepoint('t0');
    kdb.executeQuery('ROLLBACK TRANSACTION');
    expect(() => kdb.rollbackSavepoint('t0')).toThrow('no such savepoint: t0');

    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('key', 'value');
    kdb.releaseSavepoint('t0');

    expect(kdb.kernelKVStore.get('key')).toBe('value');
  });
});
