import { describe, it, expect, vi } from 'vitest';

import { deliverHandler } from './deliver.ts';
import type { HandleDelivery } from './deliver.ts';

describe('deliverHandler', () => {
  it('should deliver a message', async () => {
    const handleDelivery = vi.fn(async () =>
      Promise.resolve({ checkpoint: 'fake' }),
    ) as unknown as HandleDelivery;
    const result = deliverHandler.implementation(
      { handleDelivery },
      {
        delivery: [
          'message',
          'test',
          { methargs: { body: 'test', slots: [] }, result: null },
        ],
        crankNumber: 7,
      },
    );
    expect(handleDelivery).toHaveBeenCalledWith(
      [
        'message',
        'test',
        { methargs: { body: 'test', slots: [] }, result: null },
      ],
      7,
    );
    expect(await result).toStrictEqual({
      checkpoint: 'fake',
    });
  });

  it('should propagate errors from hooks', async () => {
    const handleDelivery = vi.fn(() => {
      throw new Error('fake');
    });
    await expect(
      deliverHandler.implementation(
        { handleDelivery },
        {
          delivery: [
            'message',
            'test',
            { methargs: { body: 'test', slots: [] }, result: null },
          ],
          crankNumber: 7,
        },
      ),
    ).rejects.toThrow('fake');
  });
});
