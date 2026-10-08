import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished } from 'vitest';

import { makeSQLKernelDatabase } from './nodejs.ts';

describe('the Node driver on real SQLite', () => {
  it('keeps nothing a crank writes after SQLite rolls its transaction back', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-store-'));
    onTestFinished(async () => rm(dir, { recursive: true, force: true }));
    const dbFilename = join(dir, 'store.db');
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
    expect(() => kdb.rollbackSavepoint('t1')).toThrow(
      'SQLite already ended the transaction holding savepoint t1',
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
});
