import { describe, expect, it, vi } from 'vitest';

import { makeAccounting } from './accountable.ts';
import type { AccountabilityReporter } from './accountable.ts';
import { makeDefaultExo } from './exo.ts';

// This package's tests run under `mock-endoify`, where `E` has no
// `HandledPromise` and nothing is a remotable to `getInterfaceOf`.
vi.mock('@endo/eventual-send', () => ({
  E: (target: Record<string, (...args: unknown[]) => unknown>) =>
    new Proxy(target, {
      get(obj, prop: string) {
        return async (...args: unknown[]) => obj[prop]?.(...args);
      },
    }),
}));
vi.mock('@endo/pass-style', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@endo/pass-style')>()),
  getInterfaceOf: (obj: { [Symbol.toStringTag]?: string }) =>
    obj[Symbol.toStringTag],
}));

/**
 * Let the eventual sends of a turn settle.
 *
 * @returns A promise for the next macrotask.
 */
const settle = async (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

const makeReporter = (): AccountabilityReporter => ({
  exercise: vi.fn(async () => undefined),
  convey: vi.fn(async () => undefined),
});

describe('makeAccounting', () => {
  describe('accountable', () => {
    it('reports each invocation of a method of the wrapper as an exercise of the wrapper', async () => {
      const reporter = makeReporter();
      const { accountable } = makeAccounting(reporter);
      const thing = accountable(
        makeDefaultExo('thing', {
          poke: () => 'poked',
          add: (left: number, right: number) => left + right,
        }),
      );
      expect([thing.poke(), thing.add(2, 3)]).toStrictEqual(['poked', 5]);
      await settle();
      expect(vi.mocked(reporter.exercise).mock.calls).toStrictEqual([
        [thing, 'poke'],
        [thing, 'add'],
      ]);
    });

    it('keeps the name, and wraps no method of the exo machinery', () => {
      const { accountable } = makeAccounting(makeReporter());
      const thing = accountable(makeDefaultExo('thing', { poke: () => 1 }));
      expect(
        (thing as { [Symbol.toStringTag]?: string })[Symbol.toStringTag],
      ).toBe('Alleged: thing');
      expect(
        Object.getOwnPropertyNames(Object.getPrototypeOf(thing)).filter(
          (name) => !name.startsWith('__'),
        ),
      ).toStrictEqual(['poke']);
    });

    it('invokes the method even when the report fails', async () => {
      const reporter = makeReporter();
      vi.mocked(reporter.exercise).mockRejectedValue(new Error('no'));
      const { accountable } = makeAccounting(reporter);
      const thing = accountable(makeDefaultExo('thing', { poke: () => 1 }));
      expect(thing.poke()).toBe(1);
      await settle();
    });
  });

  it('convey reports the hand-off declared', async () => {
    const reporter = makeReporter();
    const { convey } = makeAccounting(reporter);
    const thing = makeDefaultExo('thing', {});
    const holder = makeDefaultExo('holder', {});
    await convey(thing, holder);
    expect(reporter.convey).toHaveBeenCalledWith(thing, holder);
  });
});
