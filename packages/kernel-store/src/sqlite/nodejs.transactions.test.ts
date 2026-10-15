import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, onTestFinished } from 'vitest';

import { makeSQLKernelDatabase } from './nodejs.ts';

describe('the Node driver on real SQLite', () => {
  it('commits a savepoint opened after SQLite ends the transaction itself', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'kernel-store-'));
    onTestFinished(async () => rm(dir, { recursive: true, force: true }));
    const dbFilename = join(dir, 'store.db');
    const kdb = await makeSQLKernelDatabase({ dbFilename });
    kdb.createSavepoint('t0');
    kdb.executeQuery('PRAGMA max_page_count = 1');
    expect(() => kdb.kernelKVStore.set('key', 'x'.repeat(100_000))).toThrow(
      'database or disk is full',
    );
    kdb.executeQuery('PRAGMA max_page_count = 1073741823');

    kdb.createSavepoint('t1');
    kdb.kernelKVStore.set('key', 'value');
    kdb.releaseSavepoint('t1');
    kdb.close();

    const reopened = await makeSQLKernelDatabase({ dbFilename });
    expect(reopened.kernelKVStore.get('key')).toBe('value');
    reopened.close();
  });
});
