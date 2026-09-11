/**
 * Filter providers by guard matching at an invocation point.
 */

import { GET_INTERFACE_GUARD } from '@endo/exo';
import { matches } from '@endo/patterns';
import type { InterfaceGuard } from '@endo/patterns';
import {
  getInterfaceMethodGuards,
  getMethodPayload,
} from '@metamask/kernel-utils';

import type { Section } from './types.ts';

/**
 * Check whether an interface guard covers the invocation point (method, args).
 *
 * @param guard - The interface guard to test.
 * @param method - The method name being invoked.
 * @param args - The arguments to the method invocation.
 * @returns True if the guard accepts the invocation.
 */
export const guardCoversPoint = (
  guard: InterfaceGuard,
  method: string,
  args: unknown[],
): boolean => {
  const methodGuards = getInterfaceMethodGuards(guard);
  if (!(method in methodGuards)) {
    return false;
  }
  const methodGuard = methodGuards[method];
  if (!methodGuard) {
    return false;
  }
  const { argGuards, optionalArgGuards, restArgGuard } =
    getMethodPayload(methodGuard);
  const optionals = optionalArgGuards ?? [];
  const maxFixedArgs = argGuards.length + optionals.length;
  return (
    args.length >= argGuards.length &&
    (restArgGuard !== undefined || args.length <= maxFixedArgs) &&
    args
      .slice(0, argGuards.length)
      .every((arg, i) => matches(arg, argGuards[i])) &&
    args
      .slice(argGuards.length, maxFixedArgs)
      .every((arg, i) => matches(arg, optionals[i])) &&
    (restArgGuard === undefined ||
      args.slice(maxFixedArgs).every((arg) => matches(arg, restArgGuard)))
  );
};

/**
 * Get the matching providers at an invocation point.
 *
 * Returns the providers whose guards accept the given method + args.
 *
 * @param providers - The providers to filter.
 * @param method - The method name being invoked.
 * @param args - The arguments to the method invocation.
 * @returns The providers whose guards accept the invocation.
 */
export const getMatchingProviders = <T extends { exo: Section }>(
  providers: readonly T[],
  method: string,
  args: unknown[],
): T[] => {
  return providers.filter(({ exo }) => {
    const interfaceGuard = exo[GET_INTERFACE_GUARD]?.();
    if (!interfaceGuard) {
      return false;
    }
    return guardCoversPoint(interfaceGuard, method, args);
  });
};
