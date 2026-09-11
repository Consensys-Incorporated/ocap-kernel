import {
  M,
  getInterfaceGuardPayload,
  getMethodGuardPayload,
} from '@endo/patterns';
import type { InterfaceGuard, MethodGuard, Pattern } from '@endo/patterns';

export type MethodGuardPayload = {
  argGuards: Pattern[];
  optionalArgGuards?: Pattern[];
  restArgGuard?: Pattern;
  returnGuard: Pattern;
};

/**
 * Extract the typed method guard map from an interface guard.
 *
 * @param guard - The interface guard to inspect.
 * @returns A record mapping method names to their guards.
 */
export const getInterfaceMethodGuards = (
  guard: InterfaceGuard,
): Record<string, MethodGuard> =>
  (
    getInterfaceGuardPayload(guard) as unknown as {
      methodGuards: Record<string, MethodGuard>;
    }
  ).methodGuards;

/**
 * Extract the typed payload from a method guard.
 *
 * @param guard - The method guard to inspect.
 * @returns The guard's argument and return guard components.
 */
export const getMethodPayload = (guard: MethodGuard): MethodGuardPayload =>
  getMethodGuardPayload(guard) as unknown as MethodGuardPayload;

/**
 * Read the guard at an argument position, walking required args, then
 * optionals, then the rest guard.
 *
 * @param payload - The method guard payload to read from.
 * @param idx - The argument position.
 * @returns The guard at that position, or undefined if the payload has none.
 */
export const getGuardAt = (
  payload: MethodGuardPayload,
  idx: number,
): Pattern | undefined => {
  if (idx < payload.argGuards.length) {
    return payload.argGuards[idx];
  }
  const optIdx = idx - payload.argGuards.length;
  if (payload.optionalArgGuards && optIdx < payload.optionalArgGuards.length) {
    return payload.optionalArgGuards[optIdx];
  }
  return payload.restArgGuard;
};

/**
 * Assemble a MethodGuard from its components.
 *
 * The @endo/patterns builder API requires a strict chain order:
 * callWhen → optional → rest → returns. All four combinations of
 * optional/rest presence are handled here so callers don't repeat this logic.
 *
 * @param base - Result of M.callWhen(...requiredArgs).
 * @param optionals - Optional positional arg guards (may be empty).
 * @param restGuard - Rest arg guard, or undefined if none.
 * @param returnGuard - Return value guard.
 * @returns The assembled MethodGuard.
 */
export const buildMethodGuard = (
  base: ReturnType<typeof M.callWhen>,
  optionals: Pattern[],
  restGuard: Pattern | undefined,
  returnGuard: Pattern,
): MethodGuard => {
  if (optionals.length > 0 && restGuard !== undefined) {
    return base
      .optional(...optionals)
      .rest(restGuard)
      .returns(returnGuard);
  } else if (optionals.length > 0) {
    return base.optional(...optionals).returns(returnGuard);
  } else if (restGuard === undefined) {
    return base.returns(returnGuard);
  }
  return base.rest(restGuard).returns(returnGuard);
};

/**
 * Upgrade all method guards in an interface guard to M.callWhen for async dispatch.
 *
 * @param resolvedGuard - The interface guard whose methods should be upgraded.
 * @returns A record of async method guards keyed by method name.
 */
export const asyncifyMethodGuards = (
  resolvedGuard: InterfaceGuard,
): Record<string, MethodGuard> => {
  const resolvedMethodGuards = getInterfaceMethodGuards(resolvedGuard);
  const asyncMethodGuards: Record<string, MethodGuard> = {};
  for (const [methodName, methodGuard] of Object.entries(
    resolvedMethodGuards,
  )) {
    const { argGuards, optionalArgGuards, restArgGuard, returnGuard } =
      getMethodPayload(methodGuard);
    const optionals = optionalArgGuards ?? [];
    asyncMethodGuards[methodName] = buildMethodGuard(
      M.callWhen(...argGuards),
      optionals,
      restArgGuard,
      returnGuard,
    );
  }
  return asyncMethodGuards;
};
