import type { JSPrimitive } from '@endo/pass-style';
import type { PromiseKit } from '@endo/promise-kit';
import type { Infer, Struct } from '@metamask/superstruct';
import { array, empty, is, object, string, union } from '@metamask/superstruct';
import {
  isObject,
  UnsafeJsonStruct,
  JsonRpcRequestStruct,
  JsonRpcResponseStruct,
  JsonRpcNotificationStruct,
} from '@metamask/utils';
import type {
  JsonRpcNotification,
  JsonRpcRequest,
  JsonRpcResponse,
} from '@metamask/utils';

export type TypeGuard<Type> = (value: unknown) => value is Type;

export type ExtractGuardType<Guard, Bound = unknown> = Guard extends (
  value: unknown,
) => value is infer Type
  ? Type extends Bound
    ? Type
    : never
  : never;

const primitives = new Set([
  'string',
  'number',
  'bigint',
  'boolean',
  'symbol',
  'null',
  'undefined',
]);

export const isPrimitive = (value: unknown): value is JSPrimitive =>
  value === null || primitives.has(typeof value);

export const isTypedArray = <ElementType>(
  value: unknown,
  isElement: TypeGuard<ElementType>,
): value is ElementType[] =>
  Array.isArray(value) && !value.some((ele) => !isElement(ele));

export const isTypedObject = <ValueType>(
  value: unknown,
  isValue: TypeGuard<ValueType>,
): value is { [Key in keyof object]: ValueType } =>
  isObject(value) && !Object.values(value).some((val) => !isValue(val));

export type PromiseCallbacks<Resolve = unknown> = Omit<
  PromiseKit<Resolve>,
  'promise'
>;

/**
 * Utility type that wraps all method return types in Promise.
 * Methods already returning Promise<T> remain Promise<T>.
 */
export type Promisified<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
    ? (...args: A) => Promise<R>
    : T[K] extends (...args: infer A) => infer R
      ? (...args: A) => Promise<R>
      : T[K];
};

export const EmptyJsonArray = empty(array(UnsafeJsonStruct));

export type EmptyJsonArray = Infer<typeof EmptyJsonArray>;

export type JsonRpcCall = JsonRpcRequest | JsonRpcNotification;

export const JsonRpcCallStruct: Struct<JsonRpcCall> = union([
  JsonRpcRequestStruct,
  JsonRpcNotificationStruct,
]);

export const isJsonRpcCall = (value: unknown): value is JsonRpcCall =>
  is(value, JsonRpcCallStruct);

export type JsonRpcMessage =
  | JsonRpcNotification
  | JsonRpcRequest
  | JsonRpcResponse;

export const JsonRpcMessageStruct: Struct<JsonRpcMessage> = union([
  JsonRpcNotificationStruct,
  JsonRpcRequestStruct,
  JsonRpcResponseStruct,
]);

export const isJsonRpcMessage = (value: unknown): value is JsonRpcMessage =>
  is(value, JsonRpcMessageStruct);

/**
 * Check whether a value has the shape of Endo CapData (`{ body: string, slots: string[] }`).
 *
 * @param value - The value to check.
 * @returns `true` when `value` looks like CapData.
 */
export const CapDataStruct = object({ body: string(), slots: array(string()) });

export const isCapData = (
  value: unknown,
): value is { body: string; slots: string[] } => is(value, CapDataStruct);
