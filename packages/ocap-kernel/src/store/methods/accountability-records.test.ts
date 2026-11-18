import { describe, it, expect, beforeEach } from 'vitest';

import { kser } from '../../liveslots/kernel-marshal.ts';
import type { KRef } from '../../types.ts';
import { asKRef, asRemoteId, asVatId, asVRef } from '../../../test/branded.ts';
import { makeMapKernelDatabase } from '../../../test/storage.ts';
import { makeKernelStore } from '../index.ts';

const v1 = asVatId('v1');
const v2 = asVatId('v2');
const r0 = asRemoteId('r0');

describe('accountability record methods', () => {
  let kdb: ReturnType<typeof makeMapKernelDatabase>;
  let kernelStore: ReturnType<typeof makeKernelStore>;
  let ko1: KRef;

  beforeEach(() => {
    kdb = makeMapKernelDatabase();
    kernelStore = makeKernelStore(kdb);
    ko1 = kernelStore.initKernelObject(v1);
  });

  describe('tracking', () => {
    it('tracks an object for each holder that asks, until the last untracks it', () => {
      expect(kernelStore.isTracked(ko1)).toBe(false);
      kernelStore.trackObject(ko1, v1, { recordArgs: true });
      kernelStore.trackObject(ko1, v2);
      expect(kernelStore.isTracked(ko1)).toBe(true);
      expect(kernelStore.getTrackers(ko1)).toStrictEqual({
        v1: { recordArgs: true },
        v2: {},
      });
      expect(kernelStore.untrackObject(ko1, v1)).toBe(true);
      expect(kernelStore.isTracked(ko1)).toBe(true);
      expect(kernelStore.untrackObject(ko1, v2)).toBe(true);
      expect(kernelStore.isTracked(ko1)).toBe(false);
      expect(kernelStore.getTrackers(ko1)).toStrictEqual({});
    });

    it('pins the object once, for as long as anyone tracks it', () => {
      kernelStore.trackObject(ko1, v1);
      kernelStore.trackObject(ko1, v2);
      expect(kernelStore.getPinCount(ko1)).toBe(1);
      kernelStore.untrackObject(ko1, v1);
      expect(kernelStore.getPinCount(ko1)).toBe(1);
      kernelStore.untrackObject(ko1, v2);
      expect(kernelStore.getPinCount(ko1)).toBe(0);
    });

    it('reports an untrack by a holder that was not tracking', () => {
      kernelStore.trackObject(ko1, v1);
      expect(kernelStore.untrackObject(ko1, v2)).toBe(false);
      expect(kernelStore.isTracked(ko1)).toBe(true);
    });

    it('replaces what a holder asked for when it tracks again', () => {
      kernelStore.trackObject(ko1, v1, { recordArgs: true });
      kernelStore.trackObject(ko1, v1);
      expect(kernelStore.getTrackers(ko1)).toStrictEqual({ v1: {} });
    });

    it('forgets the trackers of a deleted object', () => {
      kernelStore.trackObject(ko1, v1);
      kernelStore.deleteKernelObject(ko1);
      expect(kernelStore.isTracked(ko1)).toBe(false);
      expect(kdb.kernelKVStore.get(`tracker.${v1}.${ko1}`)).toBeUndefined();
    });

    it('untracks everything a deleted endpoint tracked, and nothing else', () => {
      const ko2 = kernelStore.initKernelObject(v1);
      const ko3 = kernelStore.initKernelObject(v1);
      kernelStore.trackObject(ko1, v2);
      kernelStore.trackObject(ko2, v2);
      kernelStore.trackObject(ko2, r0);
      kernelStore.trackObject(ko3, r0);

      kernelStore.deleteEndpoint(v2);

      expect(kernelStore.getTrackers(ko1)).toStrictEqual({});
      expect(kernelStore.getPinCount(ko1)).toBe(0);
      expect(kernelStore.getTrackers(ko2)).toStrictEqual({ r0: {} });
      expect(kernelStore.getPinCount(ko2)).toBe(1);
      expect(kernelStore.getTrackers(ko3)).toStrictEqual({ r0: {} });
    });

    it('untracks the exports of a vat being cleaned up', () => {
      kernelStore.addCListEntry(v1, ko1, asVRef('o+1'));
      kernelStore.trackObject(ko1, v1);
      kernelStore.trackObject(ko1, v2);
      kernelStore.markVatAsTerminated(v1);

      kernelStore.cleanupTerminatedVat(v1);

      expect(kernelStore.isTracked(ko1)).toBe(false);
      expect(kernelStore.getPinCount(ko1)).toBe(0);
    });
  });

  describe('recordIntroduction', () => {
    it.each([
      [
        'a message',
        { via: 'message', sender: v2 },
        { sender: 'v2', via: 'message' },
      ],
      [
        'a notify',
        { via: 'notify', sender: 'kernel' },
        { sender: 'kernel', via: 'notify' },
      ],
      [
        'an ocap URL redemption',
        { via: 'ocap-url' },
        { sender: null, via: 'ocap-url' },
      ],
      ['no delivery context', undefined, { sender: null, via: 'unknown' }],
    ] as const)(
      'records an acquisition carried by %s',
      (_what, context, expected) => {
        kernelStore.startCrank();
        kernelStore.incrementCrankNumber();
        kernelStore.setCurrentDelivery(context);
        kernelStore.recordIntroduction({ kref: ko1, endpoint: r0 });
        expect(kernelStore.getAccountabilityRecords()).toStrictEqual([
          {
            seq: 1,
            kind: 'introduction',
            witness: 'kernel',
            crankNumber: 1,
            kref: ko1,
            endpoint: r0,
            ...expected,
          },
        ]);
      },
    );
  });

  describe('recordDelivery', () => {
    const message = {
      methargs: kser(['doIt', ['x']]),
      result: asKRef('kp3'),
    };

    it('records the message without its arguments', () => {
      kernelStore.trackObject(ko1, v1);
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: v1,
        sender: v2,
        cause: 4,
        method: 'doIt',
        message: {
          ...message,
          methargs: { ...message.methargs, slots: [ko1, ko1] },
        },
      });
      expect(kernelStore.getAccountabilityRecords()).toStrictEqual([
        {
          seq: 1,
          kind: 'delivery',
          witness: 'kernel',
          crankNumber: 0,
          target: ko1,
          targetEndpoint: v1,
          sender: v2,
          cause: 4,
          method: 'doIt',
          slots: [ko1],
          result: 'kp3',
          wallClock: expect.any(Number),
        },
      ]);
    });

    it('keeps the arguments when a tracker asked for them', () => {
      kernelStore.trackObject(ko1, v1);
      kernelStore.trackObject(ko1, v2, { recordArgs: true });
      kernelStore.recordDelivery({
        target: ko1,
        targetEndpoint: v1,
        sender: v2,
        cause: 'async',
        method: 'doIt',
        message: { methargs: message.methargs },
      });
      expect(kernelStore.getAccountabilityRecords()[0]).toStrictEqual(
        expect.objectContaining({ args: message.methargs, result: null }),
      );
    });
  });

  it('records a conveyance', () => {
    kernelStore.recordConveyance({
      kref: ko1,
      sender: v1,
      to: r0,
      via: 'notify',
      carrier: asKRef('kp2'),
    });
    expect(kernelStore.getAccountabilityRecords({ kref: ko1 })).toStrictEqual([
      {
        seq: 1,
        kind: 'conveyance',
        witness: 'kernel',
        crankNumber: 0,
        kref: ko1,
        sender: v1,
        to: r0,
        via: 'notify',
        carrier: 'kp2',
      },
    ]);
  });

  describe('getAccountabilityRecords and pruneAccountabilityRecords', () => {
    beforeEach(() => {
      kernelStore.recordConveyance({
        kref: ko1,
        sender: v1,
        to: v2,
        via: 'message',
        carrier: ko1,
      });
      kernelStore.recordConveyance({
        kref: ko1,
        sender: v2,
        to: r0,
        via: 'message',
        carrier: ko1,
      });
    });

    it('reads the records a filter selects', () => {
      expect(
        kernelStore
          .getAccountabilityRecords({ involving: v2 })
          .map((record) => record.seq),
      ).toStrictEqual([1, 2]);
      expect(
        kernelStore
          .getAccountabilityRecords({ endpoint: r0 })
          .map((record) => record.seq),
      ).toStrictEqual([2]);
    });

    it('deletes the records a filter selects and nothing else', () => {
      expect(kernelStore.pruneAccountabilityRecords({ endpoint: v2 })).toBe(1);
      expect(
        kernelStore.getAccountabilityRecords().map((record) => record.seq),
      ).toStrictEqual([2]);
    });
  });
});
