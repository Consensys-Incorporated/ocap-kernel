import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DeliveryContext } from './delivery-context.ts';

describe('DeliveryContext', () => {
  // SES lockdown freezes Date, so vi.useFakeTimers() cannot be used here.
  let lifts: (() => void)[];

  /**
   * Run the macrotasks queued so far, as the host would.
   */
  const nextMacrotask = (): void => {
    for (const lift of lifts.splice(0)) {
      lift();
    }
  };

  beforeEach(() => {
    lifts = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback: () => void,
    ) => {
      lifts.push(callback);
      return 0;
    }) as unknown as typeof setTimeout);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('charges a delivery to its crank while it runs', async () => {
    const context = new DeliveryContext();
    let during: [number | undefined, boolean] | undefined;
    await context.deliver(7, async () => {
      during = [context.crank, context.delivering];
    });
    expect(during).toStrictEqual([7, true]);
    expect([context.crank, context.delivering]).toStrictEqual([
      undefined,
      false,
    ]);
  });

  it('charges nothing to a delivery with no crank', async () => {
    const context = new DeliveryContext();
    let during: [number | undefined, boolean] | undefined;
    await context.deliver(undefined, async () => {
      during = [context.crank, context.delivering];
    });
    expect(during).toStrictEqual([undefined, false]);
  });

  describe('timer', () => {
    it('charges a callback to the crank it was scheduled in, until the next macrotask', async () => {
      const context = new DeliveryContext();
      const handlers: (() => void)[] = [];
      const set = vi.fn((handler: unknown, ..._rest: unknown[]) => {
        handlers.push(handler as () => void);
        return 42;
      });
      const charging = context.timer(set);
      const seen: (number | undefined)[] = [];
      await context.deliver(7, async () => {
        expect(charging(() => seen.push(context.crank), 10, 'arg')).toBe(42);
      });
      expect(set).toHaveBeenCalledWith(expect.any(Function), 10, 'arg');
      expect(context.crank).toBeUndefined();
      handlers[0]?.();
      expect(seen).toStrictEqual([7]);
      expect([context.crank, context.delivering]).toStrictEqual([7, false]);
      nextMacrotask();
      expect(context.crank).toBeUndefined();
    });

    it('keeps a later callback charged when an earlier charge is lifted', async () => {
      const context = new DeliveryContext();
      const handlers: (() => void)[] = [];
      const charging = context.timer((handler: unknown) => {
        handlers.push(handler as () => void);
        return 0;
      });
      await context.deliver(7, async () => {
        charging(() => undefined);
      });
      await context.deliver(8, async () => {
        charging(() => undefined);
      });
      handlers[0]?.();
      handlers[1]?.();
      expect(context.crank).toBe(8);
      lifts.shift()?.();
      expect(context.crank).toBe(8);
      lifts.shift()?.();
      expect(context.crank).toBeUndefined();
    });

    it('charges a callback scheduled outside any crank to nothing', () => {
      const context = new DeliveryContext();
      const handlers: (() => void)[] = [];
      const charging = context.timer((handler: unknown) => {
        handlers.push(handler as () => void);
        return 0;
      });
      const seen: (number | undefined)[] = [];
      charging(() => seen.push(context.crank));
      handlers[0]?.();
      expect(seen).toStrictEqual([undefined]);
      expect(lifts).toStrictEqual([]);
    });

    it('passes a handler that is not a function through', () => {
      const context = new DeliveryContext();
      const set = vi.fn((..._args: unknown[]) => 0);
      context.timer(set)('nope', 10);
      expect(set).toHaveBeenCalledWith('nope', 10);
    });
  });

  describe('fetch', () => {
    it('charges the response and its body to the crank of the request', async () => {
      const context = new DeliveryContext();
      const base = vi.fn(async () => new Response('body', { status: 201 }));
      const charging = context.fetch(base as unknown as typeof fetch);
      const response = await context.deliver(7, async () =>
        charging('https://example.test/'),
      );
      expect(base).toHaveBeenCalledWith('https://example.test/');
      expect([response.status, response.ok]).toStrictEqual([201, true]);
      expect(context.crank).toBe(7);
      nextMacrotask();
      expect(context.crank).toBeUndefined();
      expect(await response.clone().text()).toBe('body');
      expect(context.crank).toBe(7);
      nextMacrotask();
      expect(await response.text()).toBe('body');
      expect(context.crank).toBe(7);
    });

    it('charges a failed request too', async () => {
      const context = new DeliveryContext();
      const charging = context.fetch(
        vi.fn(async () => Promise.reject(new Error('refused'))),
      );
      await expect(
        context.deliver(7, async () => charging('https://example.test/')),
      ).rejects.toThrow('refused');
      expect(context.crank).toBe(7);
    });
  });
});
