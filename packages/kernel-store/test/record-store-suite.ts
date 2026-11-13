import { describe, it, expect } from 'vitest';

import type { KernelDatabase, RecordRow } from '../src/types.ts';

/**
 * A record with every column but the ones given set to something plausible.
 *
 * @param fields - The columns to set.
 * @returns The record, ready to append.
 */
export function makeRecord(
  fields: Partial<Omit<RecordRow, 'seq'>> = {},
): Omit<RecordRow, 'seq'> {
  return {
    kind: 'delivery',
    witness: 'kernel',
    crank: 1,
    kref: 'ko1',
    endpoint: 'v1',
    sender: 'v2',
    trace: null,
    data: '{}',
    ...fields,
  };
}

/**
 * The tests every driver's record store must pass, on real SQLite.
 *
 * @param makeDb - Makes a fresh database.
 */
export function describeRecordStore(
  makeDb: () => Promise<KernelDatabase>,
): void {
  describe('records', () => {
    it('numbers appended records in order and reads them back', async () => {
      const { records } = await makeDb();
      expect(records.append(makeRecord({ data: 'first' }))).toBe(1);
      expect(records.append(makeRecord({ data: 'second' }))).toBe(2);
      expect(records.query()).toStrictEqual([
        { ...makeRecord({ data: 'first' }), seq: 1 },
        { ...makeRecord({ data: 'second' }), seq: 2 },
      ]);
    });

    it.each([
      ['kind', { kind: 'conveyance' }, [2]],
      ['kref', { kref: 'ko2' }, [3]],
      ['endpoint', { endpoint: 'v3' }, [3]],
      ['sender', { sender: 'kernel' }, [2]],
      ['trace', { trace: 't1' }, [3]],
      ['involving, as endpoint or sender', { involving: 'v2' }, [1, 3, 4]],
      ['throughCrank', { throughCrank: 2 }, [1, 2]],
      ['afterSeq', { afterSeq: 2 }, [3, 4]],
      ['limit', { limit: 2 }, [1, 2]],
      ['several conditions at once', { kref: 'ko1', sender: 'v3' }, [4]],
    ])('selects by %s', async (_what, filter, expected) => {
      const { records } = await makeDb();
      records.append(makeRecord({ crank: 1 }));
      records.append(
        makeRecord({ kind: 'conveyance', crank: 2, sender: 'kernel' }),
      );
      records.append(
        makeRecord({ crank: 3, kref: 'ko2', endpoint: 'v3', trace: 't1' }),
      );
      records.append(makeRecord({ crank: 3, endpoint: 'v2', sender: 'v3' }));
      expect(records.query(filter).map((row) => row.seq)).toStrictEqual(
        expected,
      );
    });

    it('deletes the records a filter selects and reports how many', async () => {
      const { records } = await makeDb();
      records.append(makeRecord({ kref: 'ko1' }));
      records.append(makeRecord({ kref: 'ko2' }));
      records.append(makeRecord({ kref: 'ko1' }));
      expect(records.delete({ kref: 'ko1' })).toBe(2);
      expect(records.query().map((row) => row.seq)).toStrictEqual([2]);
    });

    it('deletes at most the limit, earliest first', async () => {
      const { records } = await makeDb();
      records.append(makeRecord());
      records.append(makeRecord());
      records.append(makeRecord());
      expect(records.delete({ limit: 2 })).toBe(2);
      expect(records.query().map((row) => row.seq)).toStrictEqual([3]);
    });

    it('deletes everything when given no filter', async () => {
      const { records } = await makeDb();
      records.append(makeRecord());
      records.append(makeRecord());
      expect(records.delete()).toBe(2);
      expect(records.query()).toStrictEqual([]);
    });

    it('does not reuse the sequence number of a deleted record', async () => {
      const { records } = await makeDb();
      records.append(makeRecord());
      records.delete();
      expect(records.append(makeRecord())).toBe(2);
    });

    it('is emptied by clear', async () => {
      const kdb = await makeDb();
      kdb.records.append(makeRecord());
      kdb.clear();
      expect(kdb.records.query()).toStrictEqual([]);
    });

    it('rolls an append back with the savepoint that covers it', async () => {
      const kdb = await makeDb();
      kdb.records.append(makeRecord({ data: 'kept' }));
      kdb.createSavepoint('t0');
      kdb.records.append(makeRecord({ data: 'undone' }));
      kdb.rollbackSavepoint('t0');
      expect(kdb.records.query().map((row) => row.data)).toStrictEqual([
        'kept',
      ]);
    });
  });
}
