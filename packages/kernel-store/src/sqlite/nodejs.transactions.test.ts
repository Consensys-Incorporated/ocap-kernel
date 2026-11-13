import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished } from 'vitest';

import { makeSQLKernelDatabase } from './nodejs.ts';

const makeDbFilename = async (): Promise<string> => {
  const dir = await mkdtemp(join(tmpdir(), 'kernel-store-'));
  onTestFinished(async () => rm(dir, { recursive: true, force: true }));
  return join(dir, 'store.db');
};

describe('the Node driver on real SQLite', () => {
  it('keeps nothing a crank writes after SQLite rolls its transaction back', async () => {
    const dbFilename = await makeDbFilename();
    const kdb = await makeSQLKernelDatabase({ dbFilename });
    kdb.kernelKVStore.set('queue', 'before');
    kdb.createSavepoint('t0');
    kdb.createSavepoint('t1');
    kdb.kernelKVStore.set('queue', 'dequeued');
    kdb.executeQuery('PRAGMA max_page_count = 1');
    expect(() => kdb.kernelKVStore.set('big', 'x'.repeat(100_000))).toThrow(
      'database or disk is full',
    );
    kdb.executeQuery('PRAGMA max_page_count = 1073741823');

    expect(() => kdb.kernelKVStore.set('after', 'value')).toThrow(
      'refusing writes',
    );
    expect(() =>
      kdb.makeVatStore('v1').updateKVData([['after', 'value']], []),
    ).toThrow('refusing writes');
    expect(() => kdb.clear()).toThrow('refusing writes');
    expect(() => kdb.rollbackSavepoint('t1')).toThrow(
      expect.objectContaining({
        message: 'SQLite already ended the transaction holding savepoint t1',
        cause: expect.objectContaining({
          message: 'database or disk is full',
        }),
      }),
    );

    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('next', 'crank');
    kdb.releaseSavepoint('t0');
    kdb.close();

    const reopened = await makeSQLKernelDatabase({ dbFilename });
    expect({
      queue: reopened.kernelKVStore.get('queue'),
      after: reopened.kernelKVStore.get('after'),
      vatstore: reopened.makeVatStore('v1').getKVData(),
      next: reopened.kernelKVStore.get('next'),
    }).toStrictEqual({
      queue: 'before',
      after: undefined,
      vatstore: [],
      next: 'crank',
    });
    reopened.close();
  });

  it('discards a crank whose COMMIT another connection blocks', async () => {
    const dbFilename = await makeDbFilename();
    const kdb = await makeSQLKernelDatabase({ dbFilename });
    const reader = await makeSQLKernelDatabase({ dbFilename });
    // Otherwise the COMMIT waits five seconds for the lock before failing.
    kdb.executeQuery('PRAGMA busy_timeout = 0');
    reader.createSavepoint('r0');
    reader.kernelKVStore.get('queue');

    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('queue', 'dequeued');
    expect(() => kdb.releaseSavepoint('t0')).toThrow('database is locked');
    reader.releaseSavepoint('r0');
    reader.close();
    kdb.kernelKVStore.set('after', 'value');
    kdb.close();

    const reopened = await makeSQLKernelDatabase({ dbFilename });
    expect({
      queue: reopened.kernelKVStore.get('queue'),
      after: reopened.kernelKVStore.get('after'),
    }).toStrictEqual({ queue: undefined, after: 'value' });
    reopened.close();
  });

  // `select` passes `assertSafeIdentifier`, and SQLite's parser refuses it only
  // after the BEGIN has run.
  it('discards the transaction it began when SQLite refuses the savepoint', async () => {
    const dbFilename = await makeDbFilename();
    const kdb = await makeSQLKernelDatabase({ dbFilename });
    expect(() => kdb.createSavepoint('select')).toThrow('syntax error');
    kdb.kernelKVStore.set('after', 'value');
    kdb.close();

    const reopened = await makeSQLKernelDatabase({ dbFilename });
    expect(reopened.kernelKVStore.get('after')).toBe('value');
    reopened.close();
  });

  it('leaves the crank its transaction when SQLite refuses a nested savepoint', async () => {
    const dbFilename = await makeDbFilename();
    const kdb = await makeSQLKernelDatabase({ dbFilename });
    kdb.createSavepoint('t0');
    kdb.kernelKVStore.set('crank', 'done');
    expect(() => kdb.createSavepoint('select')).toThrow('syntax error');
    kdb.releaseSavepoint('t0');
    kdb.close();

    const reopened = await makeSQLKernelDatabase({ dbFilename });
    expect(reopened.kernelKVStore.get('crank')).toBe('done');
    reopened.close();
  });
});
