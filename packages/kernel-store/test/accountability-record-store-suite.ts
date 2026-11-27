import { describe, it, expect } from 'vitest';

import type { KernelDatabase, AccountabilityRecordRow } from '../src/types.ts';

/**
 * A record with every column but the ones given set to something plausible.
 *
 * @param fields - The columns to set.
 * @returns The record, ready to append.
 */
export function makeAccountabilityRecord(
  fields: Partial<Omit<AccountabilityRecordRow, 'seq'>> = {},
): Omit<AccountabilityRecordRow, 'seq'> {
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
export function describeAccountabilityRecordStore(
  makeDb: () => Promise<KernelDatabase>,
): void {
  describe('accountability records', () => {
    it('numbers appended records in order and reads them back', async () => {
      const { accountabilityRecords: records } = await makeDb();
      expect(records.append(makeAccountabilityRecord({ data: 'first' }))).toBe(
        1,
      );
      expect(records.append(makeAccountabilityRecord({ data: 'second' }))).toBe(
        2,
      );
      expect(records.query()).toStrictEqual([
        { ...makeAccountabilityRecord({ data: 'first' }), seq: 1 },
        { ...makeAccountabilityRecord({ data: 'second' }), seq: 2 },
      ]);
    });

    it.each([
      ['kind', { kind: 'conveyance' }, [2]],
      ['kref', { kref: 'ko2' }, [3]],
      ['endpoint', { endpoint: 'v3' }, [3]],
      ['sender', { sender: 'kernel' }, [2]],
      ['trace', { trace: 't1' }, [3]],
      ['involving, as endpoint or sender', { involving: 'v2' }, [1, 3, 4]],
      ['crank', { crank: 2 }, [2]],
      ['throughCrank', { throughCrank: 2 }, [1, 2]],
      ['afterSeq', { afterSeq: 2 }, [3, 4]],
      ['limit', { limit: 2 }, [1, 2]],
      ['several conditions at once', { kref: 'ko1', sender: 'v3' }, [4]],
    ])('selects by %s', async (_what, filter, expected) => {
      const { accountabilityRecords: records } = await makeDb();
      records.append(makeAccountabilityRecord({ crank: 1 }));
      records.append(
        makeAccountabilityRecord({
          kind: 'conveyance',
          crank: 2,
          sender: 'kernel',
        }),
      );
      records.append(
        makeAccountabilityRecord({
          crank: 3,
          kref: 'ko2',
          endpoint: 'v3',
          trace: 't1',
        }),
      );
      records.append(
        makeAccountabilityRecord({ crank: 3, endpoint: 'v2', sender: 'v3' }),
      );
      expect(records.query(filter).map((row) => row.seq)).toStrictEqual(
        expected,
      );
    });

    it('deletes the records a filter selects and reports how many', async () => {
      const { accountabilityRecords: records } = await makeDb();
      records.append(makeAccountabilityRecord({ kref: 'ko1' }));
      records.append(makeAccountabilityRecord({ kref: 'ko2' }));
      records.append(makeAccountabilityRecord({ kref: 'ko1' }));
      expect(records.delete({ kref: 'ko1' })).toBe(2);
      expect(records.query().map((row) => row.seq)).toStrictEqual([2]);
    });

    it('deletes at most the limit, earliest first', async () => {
      const { accountabilityRecords: records } = await makeDb();
      records.append(makeAccountabilityRecord());
      records.append(makeAccountabilityRecord());
      records.append(makeAccountabilityRecord());
      expect(records.delete({ limit: 2 })).toBe(2);
      expect(records.query().map((row) => row.seq)).toStrictEqual([3]);
    });

    it('deletes everything when given no filter', async () => {
      const { accountabilityRecords: records } = await makeDb();
      records.append(makeAccountabilityRecord());
      records.append(makeAccountabilityRecord());
      expect(records.delete()).toBe(2);
      expect(records.query()).toStrictEqual([]);
    });

    it('does not reuse the sequence number of a deleted record', async () => {
      const { accountabilityRecords: records } = await makeDb();
      records.append(makeAccountabilityRecord());
      records.delete();
      expect(records.append(makeAccountabilityRecord())).toBe(2);
    });

    it('is emptied by clear', async () => {
      const kdb = await makeDb();
      kdb.accountabilityRecords.append(makeAccountabilityRecord());
      kdb.clear();
      expect(kdb.accountabilityRecords.query()).toStrictEqual([]);
    });

    it('rolls an append back with the savepoint that covers it', async () => {
      const kdb = await makeDb();
      kdb.accountabilityRecords.append(
        makeAccountabilityRecord({ data: 'kept' }),
      );
      kdb.createSavepoint('t0');
      kdb.accountabilityRecords.append(
        makeAccountabilityRecord({ data: 'undone' }),
      );
      kdb.rollbackSavepoint('t0');
      expect(
        kdb.accountabilityRecords.query().map((row) => row.data),
      ).toStrictEqual(['kept']);
    });
  });
}
