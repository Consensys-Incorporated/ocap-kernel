import { M } from '@endo/patterns';
import type { InterfaceGuard, MethodGuard, Pattern } from '@endo/patterns';

import type { JsonSchema, MethodSchema } from './schema.ts';

/**
 * A described value: an `@endo/patterns` {@link Pattern} (the enforced shape) paired
 * with the {@link JsonSchema} that hangs descriptive text on that shape.
 *
 * The pattern is the source of truth for the invocable shape; the schema is a
 * semantic-hint projection. Authoring both from one leaf is what makes their
 * conformance a construction invariant rather than an after-the-fact check.
 */
export type Described = {
  pattern: Pattern;
  schema: JsonSchema;
};

/**
 * Like {@link Described}, but the schema may be absent — used for a method's
 * return position, where a `void` return has a pattern ({@link M.undefined}) but
 * no JSON Schema counterpart (JSON Schema cannot express `void`/`undefined`).
 */
export type DescribedReturn = {
  pattern: Pattern;
  schema: JsonSchema | undefined;
};

/**
 * A named positional method parameter: a {@link Described} value plus the name
 * under which it is hung in the method's {@link MethodSchema.args} and, after
 * discovery, the key by which a caller supplies it.
 */
export type NamedArg = {
  name: string;
  described: Described;
  optional: boolean;
};

/**
 * A described method: the {@link MethodGuard} that enforces its call shape and
 * the {@link MethodSchema} that describes it. Both are projected from the same
 * authored leaves, so they cannot drift.
 */
export type DescribedMethod = {
  guard: MethodGuard;
  schema: MethodSchema;
};

/**
 * A described interface: the {@link InterfaceGuard} that the exo membrane
 * enforces, and the per-method {@link MethodSchema} map to pass as the
 * `__getDescription__` payload. Splat both into `makeDiscoverableExo`.
 */
export type DescribedInterface = {
  interfaceGuard: InterfaceGuard;
  schemas: Record<string, MethodSchema>;
};

const withDescription = (
  schema: JsonSchema,
  description: string | undefined,
): JsonSchema =>
  description === undefined ? schema : { ...schema, description };

/**
 * A string leaf: matches a string; describes `{ type: 'string' }`.
 *
 * @param description - Optional human/LLM-facing description.
 * @returns The described string.
 */
const string = (description?: string): Described =>
  harden({
    pattern: M.string(),
    schema: withDescription({ type: 'string' }, description),
  });

/**
 * A number leaf: matches a number; describes `{ type: 'number' }`.
 *
 * @param description - Optional human/LLM-facing description.
 * @returns The described number.
 */
const number = (description?: string): Described =>
  harden({
    pattern: M.number(),
    schema: withDescription({ type: 'number' }, description),
  });

/**
 * A boolean leaf: matches a boolean; describes `{ type: 'boolean' }`.
 *
 * @param description - Optional human/LLM-facing description.
 * @returns The described boolean.
 */
const boolean = (description?: string): Described =>
  harden({
    pattern: M.boolean(),
    schema: withDescription({ type: 'boolean' }, description),
  });

/**
 * An array leaf: matches an array whose elements match `items`; describes
 * `{ type: 'array', items }`.
 *
 * @param items - The described element type.
 * @param description - Optional human/LLM-facing description.
 * @returns The described array.
 */
const arrayOf = (items: Described, description?: string): Described =>
  harden({
    pattern: M.arrayOf(items.pattern),
    schema: withDescription(
      { type: 'array', items: items.schema },
      description,
    ),
  });

/**
 * An open object leaf: matches any record (extra keys allowed); describes
 * `{ type: 'object', properties: {}, additionalProperties: true }`.
 *
 * Use when the shape is genuinely open (e.g. free-form attachments).
 *
 * @param description - Optional human/LLM-facing description.
 * @returns The described open object.
 */
const record = (description?: string): Described =>
  harden({
    pattern: M.record(),
    schema: withDescription(
      { type: 'object', properties: {}, additionalProperties: true },
      description,
    ),
  });

/**
 * A closed/shaped object leaf: matches a record with exactly the given
 * properties (extra keys are rejected), where keys not listed in `optional` are
 * required. Describes `{ type: 'object', properties, required,
 * additionalProperties: false }`.
 *
 * @param properties - The described properties, keyed by name.
 * @param options - Options bag.
 * @param options.optional - Property names that may be omitted.
 * @param options.description - Optional human/LLM-facing description.
 * @returns The described object.
 */
const object = (
  properties: Record<string, Described>,
  options: { optional?: string[]; description?: string } = {},
): Described => {
  const { optional = [], description } = options;
  const optionalSet = new Set(optional);
  const requiredPatterns: Record<string, Pattern> = {};
  const optionalPatterns: Record<string, Pattern> = {};
  const schemaProperties: Record<string, JsonSchema> = {};
  const required: string[] = [];
  for (const [key, described] of Object.entries(properties)) {
    schemaProperties[key] = described.schema;
    if (optionalSet.has(key)) {
      optionalPatterns[key] = described.pattern;
    } else {
      requiredPatterns[key] = described.pattern;
      required.push(key);
    }
  }
  return harden({
    // The empty-record rest pattern closes the record: keys beyond those listed
    // are rejected, matching the schema's `additionalProperties: false`.
    pattern: M.splitRecord(requiredPatterns, optionalPatterns, {}),
    schema: withDescription(
      {
        type: 'object',
        properties: schemaProperties,
        required,
        additionalProperties: false,
      },
      description,
    ),
  });
};

/**
 * The void return leaf: matches `undefined` (an async method that resolves to
 * nothing); has no JSON Schema counterpart.
 *
 * @returns The described void return.
 */
const nothing = (): DescribedReturn =>
  harden({ pattern: M.undefined(), schema: undefined });

/**
 * Name a positional method parameter.
 *
 * @param name - The argument name (its key in {@link MethodSchema.args}).
 * @param described - The described value at this position.
 * @param options - Options bag.
 * @param options.optional - Whether the argument may be omitted. Optional
 * arguments must be trailing (enforced by {@link describedMethod}).
 * @returns The named argument.
 */
const arg = (
  name: string,
  described: Described,
  options: { optional?: boolean } = {},
): NamedArg => harden({ name, described, optional: options.optional ?? false });

/**
 * Describe a method: build the {@link MethodGuard} (async, via `M.callWhen`,
 * since discoverable-exo methods are invoked across an eventual-send boundary)
 * and the matching {@link MethodSchema} from the same arguments.
 *
 * @param description - The method's description.
 * @param args - The positional, named arguments. Optional arguments must all be
 * trailing — `M.call(...).optional(...)` is positional, so an optional argument
 * before a required one cannot be expressed.
 * @param returns - The described return value (use {@link nothing} for `void`).
 * @returns The described method.
 */
const describedMethod = (
  description: string,
  args: NamedArg[],
  returns: DescribedReturn,
): DescribedMethod => {
  const firstOptional = args.findIndex((each) => each.optional);
  if (
    firstOptional !== -1 &&
    args.slice(firstOptional).some((each) => !each.optional)
  ) {
    throw new Error(
      'describedMethod: optional arguments must be trailing (a required argument cannot follow an optional one).',
    );
  }

  const required = args.filter((each) => !each.optional);
  const optional = args.filter((each) => each.optional);
  const base = M.callWhen(...required.map((each) => each.described.pattern));
  const guard =
    optional.length > 0
      ? base
          .optional(...optional.map((each) => each.described.pattern))
          .returns(returns.pattern)
      : base.returns(returns.pattern);

  const schemaArgs: Record<string, JsonSchema> = {};
  for (const each of args) {
    schemaArgs[each.name] = each.described.schema;
  }
  const schema: MethodSchema = {
    description,
    args: schemaArgs,
    required: required.map((each) => each.name),
    ...(returns.schema === undefined ? {} : { returns: returns.schema }),
  };

  return harden({ guard, schema });
};

/**
 * Describe an interface: collect method guards into an {@link InterfaceGuard}
 * and method schemas into the `__getDescription__` payload.
 *
 * The guard uses `defaultGuards: 'passable'` so the `__getDescription__` method
 * that `makeDiscoverableExo` injects (and which is not listed here) is allowed.
 *
 * @param name - The interface name.
 * @param methods - The described methods, keyed by method name.
 * @returns The interface guard and the per-method schema map.
 */
const describedInterface = (
  name: string,
  methods: Record<string, DescribedMethod>,
): DescribedInterface => {
  const methodGuards: Record<string, MethodGuard> = {};
  const schemas: Record<string, MethodSchema> = {};
  for (const [methodName, method] of Object.entries(methods)) {
    methodGuards[methodName] = method.guard;
    schemas[methodName] = method.schema;
  }
  const interfaceGuard = M.interface(name, methodGuards, {
    defaultGuards: 'passable',
  });
  return harden({ interfaceGuard, schemas });
};

/**
 * Combinators for authoring an `@endo/patterns` guard and a {@link MethodSchema}
 * description from a single source, so the two cannot drift.
 *
 * Leaves (`string`, `number`, `boolean`, `arrayOf`, `record`, `object`,
 * `nothing`) each yield a `{ pattern, schema }` pair; `arg` names a positional
 * parameter; `method` and `interface` assemble them.
 */
// oxlint-disable-next-line id-length -- `S` is the intended terse public namespace, mirroring `@endo/patterns`'s `M`.
export const S = harden({
  string,
  number,
  boolean,
  arrayOf,
  record,
  object,
  nothing,
  arg,
  method: describedMethod,
  interface: describedInterface,
});
