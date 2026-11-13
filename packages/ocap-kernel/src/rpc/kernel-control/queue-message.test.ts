import type { CapData } from '@endo/marshal';
import { passStyleOf } from '@endo/marshal';
import type { Json } from '@metamask/utils';
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { queueMessageSpec, queueMessageHandler } from './queue-message.ts';
import type { Kernel } from '../../Kernel.ts';
import { krefOf } from '../../liveslots/kernel-marshal.ts';
import type { SlotValue } from '../../liveslots/kernel-marshal.ts';
import type { KRef } from '../../types.ts';

describe('queueMessageSpec', () => {
  it('should define the correct method name', () => {
    expect(queueMessageSpec.method).toBe('queueMessage');
  });

  it('should define the correct parameter structure', () => {
    // Valid parameters should pass validation
    const validParams = [
      'ko123',
      'methodName',
      [1, 'string', { key: 'value' }],
    ];
    expect(() => queueMessageSpec.params.create(validParams)).not.toThrow();

    // Invalid parameters should fail validation
    const invalidParams = ['ko123', 123, [1, 'string']];
    expect(() => queueMessageSpec.params.create(invalidParams)).toThrow(
      'Expected a string',
    );
  });

  it('should define the correct result structure', () => {
    // Valid result should pass validation
    const validResult: CapData<string> = { body: 'result', slots: [] };
    expect(() => queueMessageSpec.result.create(validResult)).not.toThrow();

    // Invalid result should fail validation
    const invalidResult = 'not a CapData object';
    expect(() => queueMessageSpec.result.create(invalidResult)).toThrow(
      'Expected an object',
    );
  });
});

describe('queueMessageHandler', () => {
  let mockKernel: Pick<Kernel, 'queueMessage'>;

  beforeEach(() => {
    mockKernel = {
      queueMessage: vi.fn(),
    };
  });

  it('should correctly forward arguments to kernel.queueMessage', async () => {
    const target = 'targetId' as KRef;
    const method = 'methodName';
    const args = [1, 'string', { key: 'value' }];
    const expectedResult: CapData<KRef> = { body: 'result', slots: [] };

    vi.mocked(mockKernel.queueMessage).mockResolvedValueOnce(expectedResult);

    const result = await queueMessageHandler.implementation(
      { kernel: mockKernel },
      [target, method, args],
    );

    expect(mockKernel.queueMessage).toHaveBeenCalledWith(target, method, args);
    expect(result).toStrictEqual(expectedResult);
  });

  it('propagates rejections from kernel.queueMessage', async () => {
    const error = new Error('Queue message failed');
    vi.mocked(mockKernel.queueMessage).mockRejectedValueOnce(error);

    await expect(
      queueMessageHandler.implementation({ kernel: mockKernel }, [
        'target' as KRef,
        'method',
        [],
      ]),
    ).rejects.toThrow('Queue message failed');
  });

  describe('reference-marker sigil (`@@NAME`)', () => {
    /**
     * Invoke the handler and return whatever args reached kernel.queueMessage.
     *
     * @param args - The args to send through the handler.
     * @returns The args as kernel.queueMessage saw them.
     */
    async function forward(args: Json[]): Promise<unknown[]> {
      vi.mocked(mockKernel.queueMessage).mockResolvedValueOnce({
        body: 'r',
        slots: [],
      });
      await queueMessageHandler.implementation({ kernel: mockKernel }, [
        'target' as KRef,
        'method',
        args,
      ]);
      const call = vi.mocked(mockKernel.queueMessage).mock.calls[0];
      return call?.[2] as unknown[];
    }

    it('expands a top-level sigil string into a kslot standin', async () => {
      const [only] = await forward(['@@ko7']);
      expect(passStyleOf(only as object)).toBe('remotable');
      expect(krefOf(only as SlotValue)).toBe('ko7');
    });

    it('expands a sigil string nested inside an array', async () => {
      const [outer] = await forward([['@@ko8', 'plain']]);
      const arr = outer as unknown[];
      expect(krefOf(arr[0] as SlotValue)).toBe('ko8');
      expect(arr[1]).toBe('plain');
    });

    it('expands a sigil string nested inside an object', async () => {
      const [only] = await forward([
        { receiver: '@@ko9', label: 'parts shipment' },
      ]);
      const record = only as { receiver: SlotValue; label: string };
      expect(krefOf(record.receiver)).toBe('ko9');
      expect(record.label).toBe('parts shipment');
    });

    it('accepts a promise ref', async () => {
      const [only] = await forward(['@@kp3']);
      expect(krefOf(only as SlotValue)).toBe('kp3');
    });

    it('leaves non-sigil strings alone', async () => {
      const [only] = await forward(['ordinary string']);
      expect(only).toBe('ordinary string');
    });

    it('leaves strings with the sigil embedded (not at start) alone', async () => {
      const [only] = await forward(['prefix@@ko7']);
      expect(only).toBe('prefix@@ko7');
    });

    it('leaves strings with non-alphanumerics after the sigil alone', async () => {
      const [only] = await forward(['@@ko-7']);
      expect(only).toBe('@@ko-7');
    });

    it('leaves a bare `@@` string alone', async () => {
      const [only] = await forward(['@@']);
      expect(only).toBe('@@');
    });

    it('rejects a well-formed sigil naming a malformed kref', async () => {
      vi.mocked(mockKernel.queueMessage).mockResolvedValueOnce({
        body: 'r',
        slots: [],
      });
      await expect(
        queueMessageHandler.implementation({ kernel: mockKernel }, [
          'target' as KRef,
          'method',
          ['@@notakref'],
        ]),
      ).rejects.toThrow(/kref/iu);
      expect(mockKernel.queueMessage).not.toHaveBeenCalled();
    });

    it('preserves plain-data args unchanged', async () => {
      const input = [1, 'string', { key: 'value' }, [1, 2, 3]];
      const forwarded = await forward(input);
      expect(forwarded).toStrictEqual(input);
    });
  });
});
