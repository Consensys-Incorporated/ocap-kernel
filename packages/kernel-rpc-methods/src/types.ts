import type { Infer, Struct } from '@metamask/superstruct';
import type { JsonRpcParams, Json } from '@metamask/utils';

// Client-side types

export type MethodSignature<
  Method extends string,
  Params extends JsonRpcParams,
  Result extends Json | Promise<Json>,
> = (method: Method, params: Params) => Result;

export type MethodSpec<
  Method extends string,
  Params extends JsonRpcParams,
  Result extends Json | Promise<Json> | void | Promise<void>,
> = Result extends void | Promise<void>
  ? { method: Method; params: Struct<Params>; result?: undefined }
  : {
      method: Method;
      params: Struct<Params>;
      result: Struct<UnwrapPromise<Result>>;
    };

// `any` can safely be used in constraints.
// oxlint-disable-next-line typescript/no-explicit-any
type SpecConstraint = MethodSpec<string, any, any>;

export type MethodSpecRecord<Methods extends SpecConstraint> = {
  [Key in Methods['method']]: Extract<Methods, { method: Key }>;
};

type SpecRecordConstraint = MethodSpecRecord<SpecConstraint>;

export type ExtractMethodSignature<Spec extends SpecConstraint> =
  Spec extends ((
    method: infer Method extends string,
    params: infer Params extends JsonRpcParams,
  ) => infer Result extends Json | Promise<Json>)
    ? MethodSignature<Method, Params, Result>
    : never;

export type ExtractMethodSpec<
  Specs extends SpecRecordConstraint,
  Key extends keyof Specs = keyof Specs,
> = Specs[Key];

export type ExtractMethod<Specs extends SpecRecordConstraint> =
  ExtractMethodSpec<Specs>['method'];

export type ExtractRequest<Specs extends SpecRecordConstraint> =
  // Safe to use `any` in constraints.
  // oxlint-disable-next-line typescript/no-explicit-any
  Extract<ExtractMethodSpec<Specs>, { result: Struct<any> }>['method'];

export type ExtractNotification<Specs extends SpecRecordConstraint> = Extract<
  ExtractMethodSpec<Specs>,
  { result?: undefined }
>['method'];

export type ExtractParams<
  Method extends string,
  Specs extends SpecRecordConstraint,
> = Infer<ExtractMethodSpec<Specs, Method>['params']>;

export type ExtractResult<
  Method extends string,
  Specs extends SpecRecordConstraint,
> =
  // Safe to use `any` in constraints.
  // oxlint-disable-next-line typescript/no-explicit-any
  ExtractMethodSpec<Specs, Method> extends MethodSpec<any, any, infer Result>
    ? UnwrapPromise<Result>
    : never;

export type HandlerFunction<
  Params extends JsonRpcParams,
  Result extends Json | Promise<Json> | void | Promise<void>,
  Hooks extends Record<string, unknown>,
> = (hooks: Hooks, params: Params) => Result;

// Service-side types

export type Handler<
  Method extends string,
  Params extends JsonRpcParams,
  Result extends Json | Promise<Json> | void | Promise<void>,
  Hooks extends Record<string, unknown>,
> = MethodSpec<Method, Params, Result> & {
  hooks: { [Key in keyof Hooks]: true };
  implementation: HandlerFunction<Params, Result, Hooks>;
};

// `any` can safely be used in constraints.
// oxlint-disable-next-line typescript/no-explicit-any
type HandlerConstraint = Handler<string, any, any, any>;

export type HandlerRecord<Handlers extends HandlerConstraint> = {
  [Key in Handlers['method']]: Extract<Handlers, { method: Key }>;
};

// Utils

type UnwrapPromise<T> = T extends Promise<infer U> ? U : T;

export type MethodRequest<Method extends SpecConstraint> = {
  id: string | number | null;
  jsonrpc: '2.0';
  method: Method['method'];
  params: Infer<Method['params']>;
};
