import { makeExo } from '@endo/exo';
import type { Methods } from '@endo/exo';
import type { InterfaceGuard } from '@endo/patterns';

import { makeDefaultInterface } from './exo.ts';
import { mergeDisjointRecords } from './merge-disjoint-records.ts';
import type { MethodSchema } from './schema.ts';

/**
 * The dunder method name used to retrieve a discoverable exo's schema.
 */
export const GET_DESCRIPTION = '__getDescription__';

/**
 * A discoverable exo object that extends a base exo interface with a `__getDescription__` method
 * for runtime introspection of method schemas.
 */
export type DiscoverableExo<
  Interface extends Methods = Record<string, (...args: unknown[]) => unknown>,
  Schema extends Record<keyof Interface, MethodSchema> = Record<
    keyof Interface,
    MethodSchema
  >,
> = ReturnType<
  typeof makeExo<
    Interface & {
      /**
       * Describe the methods of the discoverable.
       *
       * @returns A schema of the methods.
       */
      [GET_DESCRIPTION]: () => Schema;
    }
  >
>;

/**
 * Shorthand for creating a discoverable `@endo/exo` remotable with default guards set to 'passable'.
 * The keys of the schema must match the keys of the methods. By convention, the schema is exhaustive.
 * In other words, the schema is a complete description of the interface. In practice, it may be incomplete.
 *
 * @param name - The name of the discoverable.
 * @param methods - The methods of the discoverable.
 * @param schema - The schema of the discoverable, with method schemas including descriptions, arguments, and return types.
 * @param interfaceGuard - The interface guard of the discoverable.
 * @returns A discoverable exo.
 */
export const makeDiscoverableExo = <
  Interface extends Methods,
  Schema extends Record<keyof Interface, MethodSchema> = Record<
    keyof Interface,
    MethodSchema
  >,
>(
  name: string,
  methods: Interface,
  schema: Schema,
  interfaceGuard: InterfaceGuard = makeDefaultInterface(name),
): DiscoverableExo<Interface, Schema> => {
  try {
    // @ts-expect-error We're intentionally not specifying method-specific interface guards.
    return makeExo(
      name,
      interfaceGuard,
      mergeDisjointRecords(methods, {
        /**
         * Describe the methods of the discoverable.
         *
         * @returns A schema of the methods.
         */
        [GET_DESCRIPTION]: () => schema,
      }),
    );
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(`Duplicate keys in records: ${GET_DESCRIPTION}`)
    ) {
      throw new Error(
        `The \`${GET_DESCRIPTION}\` method name is reserved for discoverable exos.`,
      );
    }
    throw error;
  }
};
