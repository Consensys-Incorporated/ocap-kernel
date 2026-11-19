import { describe, it, expect, vi } from 'vitest';

import { makeAbortable } from './make-abortable.ts';

const settle = async (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

describe('makeAbortable', () => {
  it('settles with the value', async () => {
    const { read } = makeAbortable(Promise.resolve('value'));

    expect(await read()).toBe('value');
  });

  it('settles with the rejection', async () => {
    const { read } = makeAbortable(Promise.reject(new Error('boom')));

    await expect(read()).rejects.toThrow('boom');
  });

  it.each([
    ['is pending', async () => new Promise<string>(() => undefined)],
    ['has resolved', async () => 'value'],
    [
      'has rejected',
      async () => {
        throw new Error('boom');
      },
    ],
  ])('rejects a read after abort when the promise %s', async (_state, make) => {
    const { read, abort } = makeAbortable(make());
    // Let a settling promise settle before the abort.
    await settle();
    await abort();

    await expect(read()).rejects.toThrow('Operation aborted.');
  });

  it('rejects a pending read on abort', async () => {
    const { read, abort } = makeAbortable(new Promise(() => undefined));

    const reading = read();
    await abort();

    await expect(reading).rejects.toThrow('Operation aborted.');
  });

  it('does not leave a rejection unhandled when never read', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    try {
      const { abort } = makeAbortable(Promise.reject(new Error('boom')));
      await abort();
      await settle();

      expect(onUnhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});
