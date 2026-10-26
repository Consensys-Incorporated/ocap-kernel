import { rpcErrors } from '@metamask/rpc-errors';
import type { Struct } from '@metamask/superstruct';
import { hasProperty } from '@metamask/utils';
import type { Json, JsonRpcParams } from '@metamask/utils';

import type { Handler } from './types.ts';

type ExtractHooks<Handlers> =
  // We only use this type to extract the hooks from the handlers,
  // so we can safely use `any` for the generic constraints.
  // oxlint-disable-next-line typescript/no-explicit-any
  Handlers extends Handler<string, any, any, infer Hooks> ? Hooks : never;

type ExtractMethods<Handlers> =
  // We only use this type to extract the hooks from the handlers,
  // so we can safely use `any` for the generic constraints.
  // oxlint-disable-next-line typescript/no-explicit-any
  Handlers extends Handler<infer Methods, any, any, any> ? Methods : never;

type HandlerRecord<
  Handlers extends Handler<
    string,
    JsonRpcParams,
    Json | void,
    Record<string, unknown>
  >,
> = Record<Handlers['method'], Handlers>;

/**
 * A registry for RPC method handlers that provides type-safe registration and execution.
 */
export class RpcService<
  // The class picks up its type from the `handlers` argument,
  // so using `any` in this constraint is safe.
  // oxlint-disable-next-line typescript/no-explicit-any
  Handlers extends HandlerRecord<Handler<string, any, any, any>>,
> {
  readonly #handlers: Handlers;

  readonly #hooks: ExtractHooks<Handlers[keyof Handlers]>;

  /**
   * Create a new HandlerRegistry with the specified method handlers.
   *
   * @param handlers - A record mapping method names to their handler implementations.
   * @param hooks - The hooks to pass to the method implementation.
   */
  constructor(
    handlers: Handlers,
    hooks: ExtractHooks<Handlers[keyof Handlers]>,
  ) {
    this.#handlers = handlers;
    this.#hooks = hooks;
  }

  /**
   * Assert that a method is registered in this registry.
   *
   * @param method - The method name to check.
   * @throws If the method is not registered.
   */
  assertHasMethod(
    method: string,
  ): asserts method is ExtractMethods<Handlers[keyof Handlers]> {
    if (!this.#hasMethod(method as ExtractMethods<Handlers[keyof Handlers]>)) {
      throw rpcErrors.methodNotFound();
    }
  }

  /**
   * Execute a method with the provided parameters. Only the hooks specified in the
   * handler's `hooks` array will be passed to the implementation.
   *
   * @param method - The method name to execute.
   * @param params - The parameters to pass to the method implementation.
   * @returns The result of the method execution.
   * @throws If the parameters are invalid.
   */
  async execute<Method extends ExtractMethods<Handlers[keyof Handlers]>>(
    method: Method,
    params: unknown,
  ): Promise<ReturnType<Handlers[Method]['implementation']>> {
    const handler = this.#getHandler(method);
    assertParams(params, handler.params);

    const expectedHooks = selectHooks(this.#hooks, handler.hooks);
    return await handler.implementation(expectedHooks, params);
  }

  /**
   * Check if a method is registered in this registry.
   *
   * @param method - The method name to check.
   * @returns Whether the method is registered.
   */
  #hasMethod<Method extends ExtractMethods<Handlers[keyof Handlers]>>(
    method: Method,
  ): boolean {
    return hasProperty(this.#handlers, method);
  }

  /**
   * Get a handler for a specific method.
   *
   * @param method - The method name to get the handler for.
   * @returns The handler for the specified method.
   * @throws If the method is not registered.
   */
  #getHandler<Method extends ExtractMethods<Handlers[keyof Handlers]>>(
    method: Method,
  ): Handlers[Method] {
    return this.#handlers[method];
  }
}

/**
 * @param params - The parameters to assert.
 * @param struct - The struct to assert the parameters against.
 * @throws If the parameters are invalid.
 */
function assertParams<Params extends JsonRpcParams>(
  params: unknown,
  struct: Struct<Params>,
): asserts params is Params {
  try {
    struct.assert(params);
  } catch (error) {
    throw new Error(`Invalid params: ${(error as Error).message}`);
  }
}

/**
 * Returns the subset of the specified `hooks` that are included in the
 * `hookNames` array. This is a Principle of Least Authority (POLA) measure
 * to ensure that each RPC method implementation only has access to the
 * API "hooks" it needs to do its job.
 *
 * @param hooks - The hooks to select from.
 * @param hookNames - The names of the hooks to select.
 * @returns The selected hooks.
 * @template Hooks - The hooks to select from.
 * @template HookName - The names of the hooks to select.
 */
function selectHooks<
  Hooks extends Record<string, unknown>,
  HookName extends keyof Hooks,
>(hooks: Hooks, hookNames: { [Key in HookName]: true }): Pick<Hooks, HookName> {
  return Object.keys(hookNames).reduce<Partial<Pick<Hooks, HookName>>>(
    (hookSubset, hookName) => {
      const key = hookName as HookName;
      hookSubset[key] = hooks[key];
      return hookSubset;
    },
    {},
  ) as Pick<Hooks, HookName>;
}
