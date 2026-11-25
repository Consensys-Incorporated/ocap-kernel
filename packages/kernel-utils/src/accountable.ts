import { E } from '@endo/eventual-send';
import { getInterfaceOf } from '@endo/pass-style';

import { makeDefaultExo } from './exo.ts';

/**
 * What the wrapper and helper report through: the `exercise` and `convey`
 * methods of the kernel's `accountability` service, as a vat holds it.
 */
export type AccountabilityReporter = {
  exercise(obj: unknown, method: string): Promise<void>;
  convey(obj: unknown, to: unknown): Promise<void>;
};

/**
 * The methods of an exo that are for its callers, by name.
 *
 * @param exo - The exo.
 * @returns The names.
 */
const methodNamesOf = (exo: object): string[] =>
  Object.getOwnPropertyNames(Object.getPrototypeOf(exo)).filter(
    (name) => !name.startsWith('__'),
  );

/**
 * Object-level accounting within a vat, on the vat's own word: records
 * written through the `accountability` service that `history` and `trace`
 * return marked as the vat's, and that nothing the kernel signs includes.
 *
 * @param reporter - The `accountability` service.
 * @returns `accountable`, which wraps an exo so that each invocation of a
 * method of the wrapper is recorded as an exercise of it, and `convey`,
 * which records a hand-off of an object to another.
 */
export const makeAccounting = (
  reporter: AccountabilityReporter,
): {
  accountable: <Exo extends object>(exo: Exo) => Exo;
  convey: (obj: unknown, to: unknown) => Promise<void>;
} =>
  harden({
    accountable: <Exo extends object>(exo: Exo): Exo => {
      const name = String(getInterfaceOf(exo) ?? 'accountable').replace(
        /^Alleged: /u,
        '',
      );
      // What the wrapper reports is an exercise of itself, since the wrapper
      // is what its callers hold.
      const self: { wrapper?: Exo } = {};
      const methods = Object.fromEntries(
        methodNamesOf(exo).map((methodName) => [
          methodName,
          (...args: unknown[]): unknown => {
            E(reporter)
              .exercise(self.wrapper, methodName)
              .catch(() => undefined);
            return (exo as Record<string, (...rest: unknown[]) => unknown>)[
              methodName
            ]?.(...args);
          },
        ]),
      );
      self.wrapper = makeDefaultExo(name, methods) as unknown as Exo;
      return self.wrapper;
    },

    convey: async (obj: unknown, to: unknown): Promise<void> =>
      E(reporter).convey(obj, to),
  });
harden(makeAccounting);
