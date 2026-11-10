/**
 * JSON-serializable type descriptors for service API specifications, plus the
 * runtime validators for each.
 *
 * A {@link ServiceDescription} captures everything a potential service
 * consumer needs to understand whether a service is useful to them: a formal
 * API spec, a natural-language description, and one or more contact points.
 */

import {
  array,
  boolean,
  enums,
  exactOptional,
  lazy,
  literal,
  object,
  record,
  string,
  union,
} from '@metamask/superstruct';
import type { Infer, Struct } from '@metamask/superstruct';

// ---------------------------------------------------------------------------
// TypeScript types (declared first so structs can reference them by name)
// ---------------------------------------------------------------------------

/**
 * Kinds that a primitive {@link TypeSpec} may carry.
 */
export const PRIMITIVE_TYPE_KINDS = [
  'string',
  'number',
  'boolean',
  'null',
  'void',
  'undefined',
  'bigint',
  'unknown',
] as const;

export type PrimitiveTypeKind = (typeof PRIMITIVE_TYPE_KINDS)[number];

export type PrimitiveTypeSpec = { kind: PrimitiveTypeKind };

export type ArrayTypeSpec = { kind: 'array'; elementType: TypeSpec };

export type ObjectTypeSpec = { kind: 'object'; spec: ObjectSpec };

export type RemotableTypeSpec = { kind: 'remotable'; spec: RemotableSpec };

export type UnionTypeSpec = { kind: 'union'; members: TypeSpec[] };

/**
 * A JSON-serializable descriptor for a type that appears in an API
 * specification.
 */
export type TypeSpec =
  | PrimitiveTypeSpec
  | ArrayTypeSpec
  | ObjectTypeSpec
  | RemotableTypeSpec
  | UnionTypeSpec;

/**
 * A typed value appearing as a method parameter or object property.
 */
export type ValueSpec = {
  description?: string;
  type: TypeSpec;
  optional?: boolean;
};

/**
 * A JSON-serializable description of a data object.
 */
export type ObjectSpec = {
  description?: string;
  properties: Record<string, ValueSpec>;
  extensible?: boolean;
};

/**
 * A JSON-serializable description of a single method.
 */
export type MethodSpec = {
  description?: string;
  parameters: ValueSpec[];
  returnType: TypeSpec;
  optional?: boolean;
};

/**
 * A JSON-serializable description of a remotable object.
 */
export type RemotableSpec = {
  description?: string;
  methods: Record<string, MethodSpec>;
  extensible?: boolean;
};

/**
 * Access models supported by a service contact endpoint.
 */
export const CONTACT_TYPES = [
  'public',
  'permissioned',
  'validatedClient',
] as const;

export type ContactType = (typeof CONTACT_TYPES)[number];

/**
 * A JSON-serializable description of a single contact point for a service.
 */
export type ServiceContactInfo = {
  contactType: ContactType;
  contactUrl: string;
};

/**
 * The full JSON-serializable description of a service.
 *
 * `providerTag` is a stable identifier that the provider assigns to each
 * service it hosts. It must be unique among services hosted by the same
 * provider (same kernel, same libp2p peer ID) and must persist across
 * restarts of that service — when a provider re-registers after a kernel
 * restart, the matcher uses the (peerId, providerTag) pair to recognize
 * the new registration as a replacement for the previous one and evict
 * the now-stale entry. Tags don't need to be globally unique: two
 * unrelated providers can both use `providerTag: 'main'` without
 * collision because their peer IDs differ. Conventional shape is a short
 * lowercase kebab-case slug naming the service.
 */
export type ServiceDescription = {
  apiSpec: ObjectSpec;
  description: string;
  contact: ServiceContactInfo[];
  providerTag: string;
};

// ---------------------------------------------------------------------------
// Runtime validators (superstruct)
//
// These mirror the TypeScript types above. Recursive references are handled
// with `lazy`; the forward-reference lint rule is disabled at the call
// sites where such references are unavoidable.
// ---------------------------------------------------------------------------

export const PrimitiveTypeSpecStruct: Struct<PrimitiveTypeSpec> = object({
  kind: enums(PRIMITIVE_TYPE_KINDS),
});

export const ArrayTypeSpecStruct: Struct<ArrayTypeSpec> = object({
  kind: literal('array'),
  // oxlint-disable-next-line typescript/no-use-before-define
  elementType: lazy(() => TypeSpecStruct),
});

export const ObjectTypeSpecStruct: Struct<ObjectTypeSpec> = object({
  kind: literal('object'),
  // oxlint-disable-next-line typescript/no-use-before-define
  spec: lazy(() => ObjectSpecStruct),
});

export const RemotableTypeSpecStruct: Struct<RemotableTypeSpec> = object({
  kind: literal('remotable'),
  // oxlint-disable-next-line typescript/no-use-before-define
  spec: lazy(() => RemotableSpecStruct),
});

export const UnionTypeSpecStruct: Struct<UnionTypeSpec> = object({
  kind: literal('union'),
  // oxlint-disable-next-line typescript/no-use-before-define
  members: array(lazy(() => TypeSpecStruct)),
});

export const TypeSpecStruct: Struct<TypeSpec, null> = union([
  PrimitiveTypeSpecStruct,
  ArrayTypeSpecStruct,
  ObjectTypeSpecStruct,
  RemotableTypeSpecStruct,
  UnionTypeSpecStruct,
]);

export const ValueSpecStruct: Struct<ValueSpec> = object({
  description: exactOptional(string()),
  type: TypeSpecStruct,
  optional: exactOptional(boolean()),
});

export const ObjectSpecStruct: Struct<ObjectSpec> = object({
  description: exactOptional(string()),
  properties: record(string(), ValueSpecStruct),
  extensible: exactOptional(boolean()),
});

export const MethodSpecStruct: Struct<MethodSpec> = object({
  description: exactOptional(string()),
  parameters: array(ValueSpecStruct),
  returnType: TypeSpecStruct,
  optional: exactOptional(boolean()),
});

export const RemotableSpecStruct: Struct<RemotableSpec> = object({
  description: exactOptional(string()),
  methods: record(string(), MethodSpecStruct),
  extensible: exactOptional(boolean()),
});

export const ContactTypeStruct = enums(CONTACT_TYPES);

export const ServiceContactInfoStruct: Struct<ServiceContactInfo> = object({
  contactType: ContactTypeStruct,
  contactUrl: string(),
});

export const ServiceDescriptionStruct: Struct<ServiceDescription> = object({
  apiSpec: ObjectSpecStruct,
  description: string(),
  contact: array(ServiceContactInfoStruct),
  providerTag: string(),
});

// Compile-time assertions that the hand-written types line up with the
// structs. These produce no runtime value.
type AssertSameShape<Left, Right> = Left extends Right
  ? Right extends Left
    ? true
    : never
  : never;

// Referencing Infer forces the struct's inferred type to be computed, so
// these aliases fail to compile if the hand-written types drift.
export type _AssertValueSpec = AssertSameShape<
  Infer<typeof ValueSpecStruct>,
  ValueSpec
>;
export type _AssertObjectSpec = AssertSameShape<
  Infer<typeof ObjectSpecStruct>,
  ObjectSpec
>;
export type _AssertMethodSpec = AssertSameShape<
  Infer<typeof MethodSpecStruct>,
  MethodSpec
>;
export type _AssertRemotableSpec = AssertSameShape<
  Infer<typeof RemotableSpecStruct>,
  RemotableSpec
>;
export type _AssertServiceDescription = AssertSameShape<
  Infer<typeof ServiceDescriptionStruct>,
  ServiceDescription
>;
